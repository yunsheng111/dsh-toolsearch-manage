// Self-update notice — "this plugin has a newer version, here is where to get it".
//
// The plugin is installed by GitHub tag, not from npm, so the DSH Market's
// npm-version update badge does not cover it. This module gives the plugin its
// own equivalent: on host start (throttled to once every 12h) it resolves the
// newest published GitHub tag and compares it against the running version.
//
// A newer tag produces exactly one prompt line per session through the
// plugin's existing guidance section — the model then tells the user, and the
// user updates the way the README documents (Market shows it too once the tag
// is mirrored to npm; the notice always names the GitHub channel, which is
// authoritative for this package).
//
// Semver tags only; drafts and malformed tags are ignored. Failure to reach
// GitHub (offline, GFW) is silent: a missing update notice must never look
// like "you are up to date", so no cache of "latest" is written on failure.

import { compareVersions } from './semver-lite.js';

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/** Fetch the repo's tags through the GitHub API; null on any failure. */
async function fetchLatestTag(repo, timeoutMs = 8000) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=20`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-toolsearch-manage-self-update' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const tags = await res.json();
    const versions = tags
      .map((t) => t.name)
      .filter((n) => TAG_RE.test(n))
      .map((n) => n.slice(1));
    if (versions.length === 0) return null;
    return versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  } catch {
    return null;
  }
}

/**
 * One update check. Returns the notice line for the guidance section, or null
 * when up to date / throttled / unreachable.
 *
 * @param {object} options
 * @param {string} options.currentVersion running package version
 * @param {string} options.repo `owner/name`
 * @param {string} options.stateFile where the {checkedAt} throttle lives
 */
export async function selfUpdateNotice({ currentVersion, repo, stateFile }) {
  let state = { checkedAt: 0 };
  try {
    state = JSON.parse(await (await import('node:fs/promises')).readFile(stateFile, 'utf8'));
  } catch {
    /* first run or unreadable — check now */
  }
  if (Date.now() - (state.checkedAt ?? 0) < CHECK_INTERVAL_MS) {
    // Throttled: reuse the last known latest without touching the network.
    if (state.latest === undefined || compareVersions(currentVersion, state.latest) >= 0) return null;
    return noticeLine(currentVersion, state.latest);
  }

  const latest = await fetchLatestTag(repo);
  try {
    const fs = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await fs.mkdir(dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch {
    /* throttle state is best-effort */
  }
  if (latest === null || compareVersions(currentVersion, latest) >= 0) return null;
  return noticeLine(currentVersion, latest);
}

/** The single notice text used by both the fresh-check and throttled paths. */
function noticeLine(currentVersion, latest) {
  return (
    `[plugin update] dsh-toolsearch-manage ${currentVersion} → v${latest} 可用。` +
    `更新渠道：GitHub tag（pnpm add "github:yunsheng111/dsh-toolsearch-manage#v${latest}"，` +
    `或仓库 scripts/update-to-tag.cmd）。检测到新版本时请把这条提醒转告用户。`
  );
}

/**
 * On-demand check for the settings page's "检查更新" button: bypasses the
 * throttle entirely and reports the raw result (including "unreachable")
 * instead of silently returning null.
 *
 * @returns {{currentVersion: string, latest: string|null, upToDate: boolean, reachable: boolean}}
 */
export async function checkForUpdate(currentVersion, repo = 'yunsheng111/dsh-toolsearch-manage') {
  const latest = await fetchLatestTag(repo);
  return {
    currentVersion,
    latest,
    upToDate: latest !== null && compareVersions(currentVersion, latest) >= 0,
    reachable: latest !== null,
  };
}
