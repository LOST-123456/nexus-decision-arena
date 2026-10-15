import type { MetadataRoute } from "next";

/**
 * This deployment is a demonstration surface: the sign-in screen shows the demo
 * accounts, and every research session is fixture data. Keeping it out of search
 * indexes is the cheapest way to avoid publishing a sign-in page whose working
 * passwords are printed on it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }]
  };
}
