import { Injectable, Logger } from '@nestjs/common';
import { ApifyClient } from 'apify-client';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { resolveMx } from 'node:dns/promises';

import { extractPublicEmails } from './email-filter';
import { isPrivateHostname, publicHttpAgent, publicHttpsAgent, RESEARCH_USER_AGENT } from './network-guard';
import { ApifyImportRequest, ScrapedLead } from './outreach.types';

interface Place {
  companyName: string;
  category?: string;
  website?: string;
  phone?: string;
  address?: string;
  country?: string;
  googleMapsUrl?: string;
  placeId?: string;
  runId?: string;
}

@Injectable()
export class ApifyScraperService {
  private readonly logger = new Logger(ApifyScraperService.name);
  private readonly contactPattern =
    /(contact|about|team|location|appointment|enquir|reach-us|get-in-touch)/i;

  async scrape(
    request: ApifyImportRequest,
  ): Promise<{ places: number; leads: ScrapedLead[]; runIds: string[] }> {
    const token = process.env.APIFY_TOKEN?.trim();
    if (!token) throw new Error('APIFY_TOKEN is required.');
    const client = new ApifyClient({ token });
    const places = new Map<string, Place>();
    const runIds: string[] = [];

    if (request.runIds?.length) {
      for (const runId of request.runIds) {
        const run = await client.run(runId).get();
        if (!run?.defaultDatasetId || run.status !== 'SUCCEEDED') {
          throw new Error(`Apify run ${runId} is not a completed dataset.`);
        }
        runIds.push(runId);
        await this.loadDataset(client, run.defaultDatasetId, places, runId);
      }
    } else {
      for (const location of request.locations) {
        const run = await client
          .actor(request.actorId ?? 'compass/crawler-google-places')
          .call({
            searchStringsArray: request.searchTerms,
            locationQuery: location,
            maxCrawledPlacesPerSearch: request.maxPlacesPerSearch ?? 100,
            language: request.language ?? 'en',
            skipClosedPlaces: true,
            scrapePlaceDetailPage: false,
            scrapeReviews: false,
            scrapeDirectories: false,
            maxImages: 0,
          });
        if (run.status !== 'SUCCEEDED') {
          throw new Error(`Apify run ended with status ${run.status}.`);
        }
        runIds.push(run.id);
        await this.loadDataset(client, run.defaultDatasetId, places, run.id);
      }
    }

    const leads = await this.enrich([...places.values()]);
    return { places: places.size, leads, runIds };
  }

  private async loadDataset(
    client: ApifyClient,
    datasetId: string,
    places: Map<string, Place>,
    runId: string,
  ) {
    const { items } = await client
      .dataset(datasetId)
      .listItems({ limit: 10_000, clean: true });
    for (const item of items as Record<string, unknown>[]) {
      const place: Place = {
        companyName: String(item.title ?? item.name ?? '').trim(),
        category: String(item.categoryName ?? item.category ?? '').trim(),
        website: this.url(String(item.website ?? '')),
        phone: String(item.phone ?? item.phoneUnformatted ?? '').trim(),
        address: String(item.address ?? '').trim(),
        country: String(item.country ?? item.countryCode ?? '').trim(),
        googleMapsUrl: String(item.url ?? '').trim(),
        placeId: String(item.placeId ?? item.cid ?? '').trim(),
        runId,
      };
      if (!place.companyName) continue;
      const key =
        place.placeId ||
        place.website ||
        `${place.companyName.toLowerCase()}|${place.address?.toLowerCase()}`;
      places.set(key, place);
    }
  }

  private async enrich(places: Place[]): Promise<ScrapedLead[]> {
    const http = axios.create({
      timeout: 20_000,
      maxRedirects: 5,
      // Listing websites are scraped data: resolve only to public addresses.
      httpAgent: publicHttpAgent,
      httpsAgent: publicHttpsAgent,
      // A literal-IP redirect target skips DNS, so the agents cannot see it.
      beforeRedirect: (options: { hostname?: string }) => {
        if (isPrivateHostname(options.hostname ?? '')) {
          throw new Error('Redirect to a non-public address.');
        }
      },
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': RESEARCH_USER_AGENT,
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const mxCache = new Map<string, Promise<boolean>>();
    const unique = new Map<string, ScrapedLead>();
    const concurrency = this.integer('WEBSITE_CONCURRENCY', 5, 20);
    let cursor = 0;

    const worker = async () => {
      while (cursor < places.length) {
        const place = places[cursor++];
        const emails = await this.websiteEmails(http, place.website);
        for (const email of emails) {
          const domain = email.split('@')[1];
          if (!(await this.hasMx(domain, mxCache))) continue;
          if (!unique.has(email)) {
            unique.set(email, {
              email,
              companyName: place.companyName,
              category: place.category,
              phone: place.phone,
              address: place.address,
              country: place.country,
              website: place.website,
              googleMapsUrl: place.googleMapsUrl,
              runId: place.runId,
            });
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, places.length) }, worker),
    );
    this.logger.log(
      `Extracted ${unique.size} MX-valid public emails from ${places.length} businesses.`,
    );
    return [...unique.values()];
  }

  private async websiteEmails(http: AxiosInstance, website?: string) {
    if (!website) return [];
    const home = await this.html(http, website);
    if (!home) return [];
    const emails = new Set(extractPublicEmails(home));
    const $ = cheerio.load(home);
    const links = new Set<string>();
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href') ?? '';
      if (!this.contactPattern.test(`${href} ${$(element).text()}`)) return;
      try {
        const url = new URL(href, website);
        if (url.origin === new URL(website).origin) links.add(url.href);
      } catch {
        // Ignore malformed links.
      }
    });
    const maxPages = this.integer('MAX_WEBSITE_PAGES', 4, 10);
    for (const link of [...links].slice(0, Math.max(0, maxPages - 1))) {
      const page = await this.html(http, link);
      for (const email of extractPublicEmails(page)) emails.add(email);
    }
    return [...emails];
  }

  private async html(http: AxiosInstance, url: string) {
    try {
      const response = await http.get(url);
      return String(response.headers['content-type'] ?? '').includes('text/html')
        ? String(response.data)
        : '';
    } catch {
      return '';
    }
  }

  private hasMx(domain: string, cache: Map<string, Promise<boolean>>) {
    if (!cache.has(domain)) {
      cache.set(
        domain,
        resolveMx(domain)
          .then((records) => records.length > 0)
          .catch(() => false),
      );
    }
    return cache.get(domain)!;
  }

  private url(value: string) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !isPrivateHostname(url.hostname)
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  }

  private integer(name: string, fallback: number, maximum: number) {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 && value <= maximum
      ? value
      : fallback;
  }
}
