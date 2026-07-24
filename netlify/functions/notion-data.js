const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DATABASES = {
  Themes: '30a60bfb-014e-8041-a28d-d7477d55e4db',
  'Sub-themes': '30a60bfb-014e-80fd-bf3d-ca01d7f171b3',
  Indicators: '30a60bfb-014e-806f-8e3a-db04271bfcdf',
  Questions: '30a60bfb-014e-8042-a72c-c6c14c2ef065',
};

function notionPageUrl(id) {
  return `https://notion.so/${id.replace(/-/g, '')}`;
}

// Relation URLs come in inconsistent formats (/p/ vs bare, with/without dashes).
// Reduce any URL or id to its 32-hex-char core so joins across DBs match reliably.
function bareId(u) {
  if (!u) return '';
  const m = String(u).replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return m ? m[0].toLowerCase() : String(u);
}

function extractSelect(prop) {
  return prop?.select?.name ?? null;
}

// Vertical is a multi-select on Themes/Sub-themes/Indicators — an item can carry
// more than one of RfC / C4C / RfN at once. Always returns an array (possibly empty).
function extractMultiSelect(prop) {
  return prop?.multi_select?.map(v => v.name) ?? [];
}

function extractStatus(prop) {
  return prop?.status?.name ?? null;
}

function extractDate(prop) {
  return prop?.date?.start ?? null;
}

function extractRichText(prop) {
  return prop?.rich_text?.map(t => t.plain_text).join('') || null;
}

function extractTitle(prop) {
  return prop?.title?.map(t => t.plain_text).join('') || null;
}

function extractRelationFirst(prop) {
  const first = prop?.relation?.[0];
  return first ? notionPageUrl(first.id) : null;
}

// Select values like "3 - Good" → extract leading digit
function extractRating(prop) {
  const name = extractSelect(prop);
  if (!name) return null;
  const match = name.match(/^(\d)/);
  return match ? parseInt(match[1], 10) : null;
}

// Formula field — returns string/number/boolean value
function extractFormula(prop) {
  const f = prop?.formula;
  if (!f) return null;
  if (f.type === 'string') return f.string || null;
  if (f.type === 'number') return f.number !== null ? String(f.number) : null;
  if (f.type === 'boolean') return String(f.boolean);
  return null;
}

// Vertical on Sub-themes ("Verticals ") and Indicators ("Vertical") is a rollup
// that pulls the parent Theme's multi-select. A rollup of a multi-select comes
// back as rollup.array, each element itself a multi_select. Flatten to names.
function extractRollupMultiSelect(prop) {
  const arr = prop?.rollup?.array;
  if (!Array.isArray(arr)) return [];
  const names = [];
  for (const item of arr) {
    if (item?.type === 'multi_select' && Array.isArray(item.multi_select)) {
      names.push(...item.multi_select.map(o => o.name));
    } else if (item?.type === 'select' && item.select?.name) {
      names.push(item.select.name);
    }
  }
  return [...new Set(names)];
}

// People field — returns comma-joined display names, or null
function extractPeopleNames(prop) {
  const people = prop?.people || [];
  return people.length ? people.map(p => p.name).join(', ') : null;
}

async function queryDatabase(databaseId, token) {
  const results = [];
  let cursor = undefined;

  do {
    const body = cursor ? JSON.stringify({ start_cursor: cursor }) : '{}';
    const response = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Notion API ${response.status} on DB ${databaseId}: ${text}`);
    }

    const data = await response.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return results;
}

function commonQaFields(props) {
  return {
    requiresAction: extractSelect(props['Requires Action']),
    actionNeededBy: extractMultiSelect(props['Action Needed By']),
    deadline: extractDate(props['Action Deadline']),
    taxonomic: extractRating(props['Taxonomic Thinking ★']),
    completeness: extractRating(props['Completeness ★']),
    construct: extractRating(props['Construct Understanding ★']),
    design: extractRating(props['Design ★']),
    notes: extractRichText(props['Review Notes']),
  };
}

function mapPage(page, dbName) {
  const props = page.properties;
  const id = notionPageUrl(page.id);
  const url = page.url || id;

  if (dbName === 'Themes') {
    return {
      id, db: 'Themes', url,
      name: extractTitle(props['Theme Name']),
      status: extractStatus(props['Theme Status']),
      vertical: extractMultiSelect(props['Vertical']),
      approvedBy: null,
      developedBy: null,
      ...commonQaFields(props),
      themeId: null,
      subthemeId: null,
      parentIndicatorId: null,
    };
  }

  if (dbName === 'Sub-themes') {
    return {
      id, db: 'Sub-themes', url,
      name: extractTitle(props['Sub-theme name']),
      status: extractStatus(props['Subtheme Status']),
      // Rollup returns <omitted /> via the API — resolved from the linked Theme in post-pass.
      vertical: [],
      approvedBy: extractPeopleNames(props['Approved By']),
      developedBy: null,
      ...commonQaFields(props),
      themeId: extractRelationFirst(props['Theme database']),
      subthemeId: null,
      parentIndicatorId: null,
    };
  }

  if (dbName === 'Indicators') {
    return {
      id, db: 'Indicators', url,
      name: extractTitle(props['Indicator statement']),
      status: extractStatus(props['Status']),
      // Rollup returns <omitted /> — resolved from the linked Subtheme in post-pass.
      vertical: [],
      approvedBy: null,
      developedBy: extractPeopleNames(props['Developed By']),
      ...commonQaFields(props),
      themeId: null,
      subthemeId: extractRelationFirst(props['Subtheme']),
      parentIndicatorId: null,
    };
  }

  if (dbName === 'Questions') {
    // Vertical is not stored on the question — Notion can't roll it up from the
    // subtheme (rollup-of-a-rollup is disallowed). Left empty here and filled from
    // the linked subtheme's verticals in a post-pass after all DBs are mapped.
    return {
      id, db: 'Questions', url,
      name: extractTitle(props['Question Text']),
      // Question Status is a select (not a status widget) — use extractSelect
      status: extractSelect(props['Question Status']),
      vertical: [],
      approvedBy: null,
      developedBy: null,
      ...commonQaFields(props),
      themeId: null,
      subthemeId: extractRelationFirst(props['Subtheme']),
      parentIndicatorId: extractRelationFirst(props['Indicator database']),
    };
  }

  return null;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    // Never let the browser or Netlify's CDN serve a stale copy — always
    // reflect the current state of Notion.
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Netlify-CDN-Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'NOTION_TOKEN environment variable is not set' }),
    };
  }

  try {
    const allItems = [];

    for (const [dbName, dbId] of Object.entries(DATABASES)) {
      const pages = await queryDatabase(dbId, token);
      for (const page of pages) {
        const mapped = mapPage(page, dbName);
        if (mapped) allItems.push(mapped);
      }
    }

    // Verticals live only on Themes (a reliable multi-select). Everything below
    // derives by walking relations, because the rollups return <omitted /> via the
    // API and the direct Indicator→Theme relation points at inaccessible pages.
    // Chain: Theme.vertical → Sub-theme (via Theme database) → Indicator/Question (via Subtheme).
    // All lookups are keyed on bareId() so mismatched URL formats still join.
    const themeVert = {};      // bareId(theme)    → verticals[]
    const subVert = {};        // bareId(subtheme) → verticals[]

    for (const item of allItems) {
      if (item.db === 'Themes') themeVert[bareId(item.id)] = item.vertical || [];
    }
    for (const item of allItems) {
      if (item.db === 'Sub-themes') {
        item.vertical = themeVert[bareId(item.themeId)] || [];
        subVert[bareId(item.id)] = item.vertical;
      }
    }
    for (const item of allItems) {
      if (item.db === 'Indicators' || item.db === 'Questions') {
        item.vertical = subVert[bareId(item.subthemeId)] || [];
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(allItems) };
  } catch (err) {
    console.error('notion-data function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};