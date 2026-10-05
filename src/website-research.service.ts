import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { isPrivateHostname, publicHttpAgent, publicHttpsAgent, RESEARCH_USER_AGENT } from './network-guard';

export interface ResearchedPage {
  url: string;
  title: string;
  text: string;
}

@Injectable()
export class WebsiteResearchService {
  async research(website: string): Promise<ResearchedPage[]> {
    const root = this.safeUrl(website);
    const homepage = await this.fetchPage(root);
    const $ = cheerio.load(homepage.html);
    const candidates = $('a[href]')
      .map((_, element) => $(element).attr('href'))
      .get()
      .map((href) => this.resolveSameHost(root, href))
      .filter((url): url is URL => Boolean(url))
      .filter((url) => /about|service|solution|product|faq|contact/i.test(url.pathname));

    const urls = [root, ...candidates]
      .filter((url, index, all) => all.findIndex((item) => item.href === url.href) === index)
      .slice(0, 5);
    const pages: ResearchedPage[] = [];
    for (const url of urls) {
      try {
        const page = url.href === root.href ? homepage : await this.fetchPage(url);
        const parsed = cheerio.load(page.html);
        parsed('script,style,noscript,svg,nav,footer').remove();
        const text = parsed('body').text().replace(/\s+/g, ' ').trim().slice(0, 12_000);
        if (text.length >= 100) {
          pages.push({ url: page.url, title: parsed('title').text().trim(), text });
        }
      } catch {
        // A secondary page failure should not discard usable company research.
      }
    }
    if (!pages.length) throw new Error('No usable public website content was found.');
    return pages;
  }

  private safeUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new Error('The lead website is not a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || isPrivateHostname(url.hostname)) {
      throw new Error('The lead website must be a public HTTP(S) URL.');
    }
    return url;
  }

  private resolveSameHost(root: URL, href?: string): URL | undefined {
    if (!href) return undefined;
    try {
      const url = new URL(href, root);
      return url.hostname === root.hostname && ['http:', 'https:'].includes(url.protocol)
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchPage(url: URL) {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      // Redirects are followed by hand so each hop is re-validated by safeUrl.
      const response = await axios.get<string>(current.href, {
        timeout: 15_000, maxContentLength: 3_000_000, responseType: 'text', maxRedirects: 0,
        httpAgent: publicHttpAgent, httpsAgent: publicHttpsAgent,
        headers: { 'user-agent': RESEARCH_USER_AGENT },
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (response.status < 300) return { url: current.href, html: response.data };
      const location = response.headers.location;
      if (!location || redirects === 3) throw new Error('Website redirected too many times.');
      const next = this.safeUrl(new URL(location, current).href);
      if (!this.sameSite(url.hostname, next.hostname)) throw new Error('Cross-domain redirects are not allowed.');
      current = next;
    }
    throw new Error('Website could not be fetched.');
  }

  private sameSite(left: string, right: string) {
    return left.replace(/^www\./i, '') === right.replace(/^www\./i, '');
  }
}
