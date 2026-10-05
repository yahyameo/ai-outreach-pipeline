// Preview or send personalised outreach for every eligible lead in one or
// more lead-list JSON files (as returned by GET /leads), one company at a time,
// through a running server.
//
//   npm run outreach:batch -- preview leads.json
//   npm run outreach:batch -- send leads.json
//
// Env: OUTREACH_API_KEY (required), OUTREACH_BASE_URL, OUTREACH_TYPE,
// OUTREACH_LOCALE, OUTREACH_REFRESH_RESEARCH, OUTREACH_REPORT_PREFIX,
// OUTREACH_EXCLUDE_EMAILS (comma-separated).
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { OUTREACH_LOCALES, OUTREACH_TYPES } from '../dist/outreach.constants.js';

const baseUrl = process.env.OUTREACH_BASE_URL ?? 'http://127.0.0.1:3000';
const apiKey = process.env.OUTREACH_API_KEY;
const mode = process.argv[2] ?? 'preview';
const outreachType = process.env.OUTREACH_TYPE ?? 'general_ai';
const locale = process.env.OUTREACH_LOCALE ?? 'en-SG';
const refreshResearch = process.env.OUTREACH_REFRESH_RESEARCH === 'true';
const reportPrefix = process.env.OUTREACH_REPORT_PREFIX ?? 'outreach-batch';
const inputFiles = process.argv.slice(3);
const excludedEmails = new Set((process.env.OUTREACH_EXCLUDE_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean));

if (!apiKey) throw new Error('OUTREACH_API_KEY is required.');
if (!['preview', 'send'].includes(mode)) throw new Error('Mode must be preview or send.');
if (!OUTREACH_TYPES.includes(outreachType)) throw new Error('OUTREACH_TYPE is invalid.');
if (!OUTREACH_LOCALES.includes(locale)) throw new Error('OUTREACH_LOCALE is invalid.');
if (inputFiles.length === 0) throw new Error('Provide at least one lead-list JSON file.');

const documents = await Promise.all(inputFiles.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
const localPart = (lead) => (lead.normalizedEmail ?? lead.email ?? '').split('@')[0].toLowerCase();
const unsuitableLocalParts = /^(abuse|billing|careers?|compliance|do-?not-?reply|dpo|finance|hr|jobs?|legal|no-?reply|privacy|recruit(?:ment|ing)?|security|support|tuyendung|webmaster)$/i;
const concatenatedExtractionArtifact = /cashier|^(?:email(?:hello|info)|stateshello|teamcontact|noticeprivacy)/i;
const contactScore = (lead) => {
  const local = localPart(lead);
  if (/^(sales|partnerships?|alliances?)$/.test(local)) return 100;
  if (/^(biz|business|commercial)$/.test(local)) return 90;
  if (/^(contact|enquiry|enquiries|hello|hi|info|inquiry)$/.test(local)) return 80;
  if (/^(marketing|admin|office)$/.test(local)) return 50;
  if (/^(support|help|helpsupport)$/.test(local)) return 20;
  return 40;
};
const eligible = documents
  .flatMap((document) => document.leads ?? [])
  .filter((lead) => ['valid', 'unknown'].includes(lead.verification?.status))
  .filter((lead) => !lead.unsubscribed)
  .filter((lead) => !excludedEmails.has(lead.normalizedEmail ?? lead.email?.toLowerCase()))
  .filter((lead) => !unsuitableLocalParts.test(localPart(lead)))
  .filter((lead) => !concatenatedExtractionArtifact.test(localPart(lead)))
  .filter((lead) => ['not_queued', 'failed'].includes(lead.delivery?.status ?? 'not_queued'))
  .sort((a, b) => {
    const verificationDifference = Number(b.verification?.status === 'valid') - Number(a.verification?.status === 'valid');
    return verificationDifference || contactScore(b) - contactScore(a);
  });

const companyKey = (lead) => (lead.companyName ?? lead.normalizedEmail?.split('@')[1] ?? lead._id)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const byCompany = new Map();
for (const lead of eligible) {
  const key = companyKey(lead);
  if (!byCompany.has(key)) byCompany.set(key, lead);
}
const selected = [...byCompany.values()];
// Reports contain recipient addresses; reports/ is gitignored.
await mkdir('reports', { recursive: true });
const reportPath = `reports/${reportPrefix}-${mode}.json`;
const report = {
  mode,
  outreachType,
  locale,
  startedAt: new Date().toISOString(),
  eligibleRecords: eligible.length,
  selectedCompanies: selected.length,
  results: [],
};

for (const [index, lead] of selected.entries()) {
  const prefix = `[${index + 1}/${selected.length}] ${lead.companyName} <${lead.email}>`;
  try {
    const response = await fetch(`${baseUrl}/leads/${lead._id}/outreach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ mode, refreshResearch, outreachType, locale }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? JSON.stringify(body));
    report.results.push({
      leadId: lead._id,
      companyName: lead.companyName,
      email: lead.email,
      verificationStatus: lead.verification?.status,
      ok: true,
      analysisStatus: body.analysis?.status,
      fitScore: body.analysis?.fitScore,
      observedSignals: body.analysis?.observedSignals,
      deliveryStatus: body.deliveryStatus,
      subject: body.email?.subject,
      messageId: body.messageId,
    });
    console.log(`${prefix}: ${body.analysis?.status ?? 'processed'} / ${body.deliveryStatus ?? mode}`);
  } catch (error) {
    report.results.push({
      leadId: lead._id,
      companyName: lead.companyName,
      email: lead.email,
      verificationStatus: lead.verification?.status,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`${prefix}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

report.completedAt = new Date().toISOString();
await writeFile(reportPath, JSON.stringify(report, null, 2));
const succeeded = report.results.filter((result) => result.ok).length;
const failed = report.results.length - succeeded;
console.log(JSON.stringify({ mode, outreachType, locale, eligibleRecords: eligible.length, selectedCompanies: selected.length, succeeded, failed }));
