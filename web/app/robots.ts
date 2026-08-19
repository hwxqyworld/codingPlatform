import type { MetadataRoute } from 'next';
import { PUBLIC_URL } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** robots.txt: 全站可爬取, 并指向 sitemap */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${PUBLIC_URL}/sitemap.xml`,
  };
}
