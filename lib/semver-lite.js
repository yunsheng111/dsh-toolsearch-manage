// Minimal semver comparison for plain `x.y.z` literals — the only shape the
// self-update tag filter admits, so prerelease/build metadata are out of
// scope. Returns >0 / 0 / <0 like conventional comparators.

/**
 * @param {string} a `x.y.z`
 * @param {string} b `x.y.z`
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
