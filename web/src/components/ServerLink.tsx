"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, type ComponentProps } from "react";
import { serverHref } from "@/lib/format";
import { useServer } from "./ServerProvider";

/**
 * The ONLY way the app links to its own pages. Wraps next/link and adds
 * `?s=<server>` when (and only when) this user should see it: people with a
 * single membership never get one. Build hrefs with `stockHref()` /
 * `profileHref()` / a plain path, and let this add the server.
 * (`web/test/hrefs.test.ts` fails if a page reaches for next/link directly.)
 */
export default function Link({ href, ...rest }: ComponentProps<typeof NextLink>) {
  const href2 = useServerHref();
  return <NextLink {...rest} href={typeof href === "string" ? href2(href) : href} />;
}

/** `serverHref(path)`: an internal path with `?s=` carried for this user (or not). */
export function useServerHref(): (href: string) => string {
  const { serverParam } = useServer();
  return useCallback((href: string) => serverHref(href, serverParam), [serverParam]);
}

/** `router.push` / `replace` that carries `?s=` like Link does. */
export function useServerRouter() {
  const router = useRouter();
  const href = useServerHref();
  return {
    push: (to: string, options?: Parameters<typeof router.push>[1]) => router.push(href(to), options),
    replace: (to: string, options?: Parameters<typeof router.replace>[1]) => router.replace(href(to), options),
  };
}
