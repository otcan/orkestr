export type CanonicalNavigationMode = "push" | "replace";

export interface CanonicalNavigationOptions {
  currentUrl?: string;
  mode?: CanonicalNavigationMode;
  history?: Pick<History, "pushState" | "replaceState">;
  location?: Pick<Location, "assign" | "replace">;
}

export interface CanonicalNavigationResult {
  navigated: boolean;
  crossOrigin: boolean;
  url?: string;
}

export function canonicalThreadPanelUrl(
  canonicalUrl?: string,
  panel?: string,
  sourceUrl?: string,
  preserveLocation?: boolean,
): string;

export function navigateCanonicalThreadTarget(
  targetUrl?: string,
  options?: CanonicalNavigationOptions,
): CanonicalNavigationResult;

export function navigateLegacyThreadPath(
  targetPath?: string,
  options?: Pick<CanonicalNavigationOptions, "currentUrl" | "mode" | "history">,
): CanonicalNavigationResult;
