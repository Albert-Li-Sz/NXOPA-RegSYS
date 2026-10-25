import assert from 'node:assert/strict';

function version(tag) {
  assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return tag.slice(1).split('.').map(BigInt);
}

export function validateLatestPromotion({ tag, latestTag, draft }) {
  const target = version(tag);
  const current = version(latestTag);
  if (tag === latestTag) {
    assert.equal(draft, false, 'Only a published Latest release can resume publication');
    return;
  }
  assert.equal(draft, true, 'A published older release cannot replace Latest');
  const difference = target.map((part, index) => part - current[index]).find((part) => part !== 0n);
  assert.ok(difference > 0n, 'Latest must advance to a newer stable version');
}
