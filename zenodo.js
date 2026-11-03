// Accepted abstracts on Zenodo, each with its own DOI (3 Nov 2026).
//
// Two steps, because publishing cannot be undone: a draft (the record, its
// metadata and a PDF, with the DOI reserved, so it can be checked on Zenodo
// first), then publish. Uses Zenodo's deposit API with a personal access
// token (scope deposit:write and deposit:actions) that the owner enters in
// the portal; the token is kept in .env, never in the database or a page.
//
// Pure where it can be: metadata and the description are built here from the
// abstract and the conference, and the HTTP calls take their fetch, base
// address and token as arguments, so tests can point them at a stand-in.

const LICENSE = 'cc-by-4.0';
const SANDBOX = 'https://sandbox.zenodo.org';
const PRODUCTION = 'https://zenodo.org';
const COMMUNITY_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

// Where the calls go: a test's stand-in, the sandbox for trial runs, or the real site.
const apiBase = ({ sandbox } = {}) => String(process.env.ZENODO_API_BASE || (sandbox ? SANDBOX : PRODUCTION)).replace(/\/+$/, '');

// "Dr. Amol Joshi" -> "Joshi, Amol": Zenodo lists creators family name first.
// A one-word name, or one already with a comma, is left as written.
function creatorName(name) {
  const tidy = String(name || '').replace(/\s+/g, ' ').trim();
  if (!tidy || tidy.includes(',')) return tidy;
  const words = tidy.replace(/^(?:dr|prof|mr|mrs|ms|miss|smt|shri)\.?\s+/i, '').split(' ');
  if (words.length < 2) return words.join(' ') || tidy;
  return `${words[words.length - 1]}, ${words.slice(0, -1).join(' ')}`;
}

// The structured abstract as the record's description. The stored sections
// are already sanitised HTML (only <b>, <i>, <sup>, <sub> survive), which
// Zenodo accepts as is.
const SECTIONS = [['Background', 'background'], ['Aim', 'aim'], ['Methods', 'methods'], ['Results', 'results'], ['Conclusion', 'conclusion']];
function descriptionHtml(abstract) {
  const parts = SECTIONS.filter(([, k]) => abstract[k] && String(abstract[k]).trim())
    .map(([label, k]) => `<p><b>${label}</b></p><p>${String(abstract[k]).trim().replace(/\n+/g, '<br>')}</p>`);
  if (!parts.length && abstract.text) parts.push(`<p>${String(abstract.text).trim().replace(/\n+/g, '<br>')}</p>`);
  return parts.join('');
}

// The record's metadata. conference: { name, acronym, dates, place, url }.
// The presenting author's institution is the only affiliation the portal
// knows, so only they carry one.
function recordMetadata({ abstract, authors, institution, conference, community, today }) {
  const keywords = String(abstract.keywords || '').split(/[,;]/).map((k) => k.replace(/&amp;/g, '&').trim()).filter(Boolean);
  const md = {
    upload_type: 'publication',
    publication_type: 'conferencepaper',
    title: String(abstract.title || '').trim(),
    creators: authors.map((a) => ({ name: creatorName(a.name), ...(a.presenting && institution ? { affiliation: institution } : {}) })),
    description: descriptionHtml(abstract),
    access_right: 'open',
    license: LICENSE,
    publication_date: today,
    language: 'eng',
    conference_title: conference.name,
    conference_acronym: conference.acronym,
    conference_dates: conference.dates,
    conference_place: conference.place,
    notes: `Abstract ${abstract.id}, accepted by the scientific committee of ${conference.acronym || conference.name}.`,
    prereserve_doi: true,
  };
  if (conference.url) md.conference_url = conference.url;
  if (keywords.length) md.keywords = keywords;
  if (community) md.communities = [{ identifier: community }];
  return md;
}

// One call to Zenodo. Answers the parsed JSON, or throws with what Zenodo said.
async function call(fetchFn, base, token, method, url, { json, body, contentType } = {}) {
  const res = await fetchFn(url.startsWith('http') ? url : `${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : body,
    timeout: 60000,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const detail = data && (data.message || (Array.isArray(data.errors) && data.errors.map((e) => [e.field, e.message || (e.messages || []).join(' ')].filter(Boolean).join(': ')).join('; ')));
    const err = new Error(`Zenodo answered ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Is the token good, and does the community exist?
async function check(fetchFn, base, token, community) {
  await call(fetchFn, base, token, 'GET', '/api/deposit/depositions?size=1');
  let communityFound = null;
  if (community) {
    try { await call(fetchFn, base, token, 'GET', `/api/communities/${encodeURIComponent(community)}`); communityFound = true; } catch (e) { if (e.status === 404) communityFound = false; else throw e; }
  }
  return { ok: true, communityFound };
}

// A new, empty draft: its id, file bucket, page and reserved DOI.
async function createDraft(fetchFn, base, token) {
  const d = await call(fetchFn, base, token, 'POST', '/api/deposit/depositions', { json: {} });
  return draftInfo(d);
}
async function getDraft(fetchFn, base, token, id) {
  return draftInfo(await call(fetchFn, base, token, 'GET', `/api/deposit/depositions/${id}`));
}
function draftInfo(d) {
  const reserved = d && d.metadata && d.metadata.prereserve_doi;
  return {
    id: d.id,
    bucket: d.links && d.links.bucket,
    url: (d.links && (d.links.html || d.links.latest_draft_html)) || null,
    doi: d.doi || (reserved && reserved.doi) || null,
    submitted: !!d.submitted,
  };
}
// The PDF, under one name, so sending the draft again replaces it.
async function putFile(fetchFn, base, token, bucket, filename, buffer) {
  return call(fetchFn, base, token, 'PUT', `${bucket}/${encodeURIComponent(filename)}`, { body: buffer, contentType: 'application/octet-stream' });
}
async function putMetadata(fetchFn, base, token, id, metadata) {
  return draftInfo(await call(fetchFn, base, token, 'PUT', `/api/deposit/depositions/${id}`, { json: { metadata } }));
}
// Permanent. Answers the DOI and the record's page.
async function publish(fetchFn, base, token, id) {
  const d = await call(fetchFn, base, token, 'POST', `/api/deposit/depositions/${id}/actions/publish`, { json: {} });
  return {
    doi: d.doi || (d.metadata && d.metadata.doi) || null,
    url: (d.links && (d.links.record_html || d.links.html)) || d.doi_url || null,
  };
}
// Only a draft can go; a published record stays for good.
async function discardDraft(fetchFn, base, token, id) {
  await call(fetchFn, base, token, 'DELETE', `/api/deposit/depositions/${id}`);
}

module.exports = {
  LICENSE, SANDBOX, PRODUCTION, COMMUNITY_RE, apiBase, creatorName, descriptionHtml, recordMetadata,
  check, createDraft, getDraft, putFile, putMetadata, publish, discardDraft,
};
