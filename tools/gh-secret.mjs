/**
 * 写 GitHub Actions secrets（需要 token 有 Secrets 读写权限）。
 *
 * 用法：node tools/gh-secret.mjs KEY=value [KEY2=value2 ...]
 *
 * GitHub 要求用仓库公钥做 libsodium sealed box 加密后再上传，
 * 所以这里依赖 libsodium-wrappers。
 */
import { readFile } from 'node:fs/promises';
import sodium from 'libsodium-wrappers';

const TOKEN = (await readFile('D:\\test\\.github-token', 'utf8')).trim();
const OWNER = 'ConspiracyThorist';
const REPO = 'zhihu-bili-blocker';
const API = 'https://api.github.com';
const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zbb-secret',
  'content-type': 'application/json',
};

const pairs = process.argv.slice(2).map((arg) => {
  const i = arg.indexOf('=');
  if (i < 1) throw new Error(`参数格式应为 KEY=value，收到：${arg}`);
  return [arg.slice(0, i), arg.slice(i + 1)];
});
if (pairs.length === 0) {
  console.error('用法：node tools/gh-secret.mjs KEY=value');
  process.exit(1);
}

await sodium.ready;

const keyRes = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/secrets/public-key`, { headers: H });
if (!keyRes.ok) {
  console.error('拿公钥失败：', keyRes.status, (await keyRes.text()).slice(0, 150));
  process.exit(1);
}
const { key, key_id: keyId } = await keyRes.json();

for (const [name, value] of pairs) {
  const sealed = sodium.crypto_box_seal(value, sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
  const encrypted = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
  });
  console.log(res.status === 201 || res.status === 204 ? `✓ ${name} 已写入` : `✗ ${name} → ${res.status} ${(await res.text()).slice(0, 120)}`);
}

const list = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/secrets`, { headers: H });
const json = await list.json();
console.log('现有 secrets：', (json.secrets ?? []).map((s) => s.name).join(', ') || '(无)');
