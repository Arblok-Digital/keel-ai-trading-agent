const PHASES = [
  { id: "01", key: "constitution", label: "Constitution", desc: "Non-negotiable principles", artifacts: ["constitution.md"] },
  { id: "02", key: "requirements", label: "Requirements", desc: "PRD + user stories", artifacts: ["prd.md"] },
  { id: "03", key: "architecture", label: "Architecture", desc: "Hulu → hilir structure", artifacts: ["architecture.md", "folder-map.txt"] },
  { id: "04", key: "contracts", label: "Contracts", desc: "API + data schema", artifacts: ["openapi.yaml", "schema.ts"] },
  { id: "05", key: "prompts", label: "System Prompts", desc: "Agent rules + shims", artifacts: ["AGENTS.md", "CLAUDE.md"] },
  { id: "06", key: "corpus", label: "RAG Corpus", desc: "Chunked knowledge base", artifacts: ["corpus-manifest.json"] },
  { id: "07", key: "export", label: "Export", desc: "Speckit bundle + shims", artifacts: ["export-manifest.json"] }
];

const ARCHETYPES = {
  "saas-dashboard": {
    label: "SaaS Dashboard",
    stack: "next.js 15 · supabase · tailwind · drizzle",
    sample: "kopikita-dashboard"
  },
  marketplace: {
    label: "Marketplace",
    stack: "next.js 15 · supabase · midtrans · drizzle",
    sample: "pasar-baru"
  },
  "rag-chatbot": {
    label: "RAG Chatbot",
    stack: "hono · pgvector · openai · langchain",
    sample: "tanya-legal-bot"
  },
  "api-service": {
    label: "API Service",
    stack: "hono · postgres · drizzle · zod",
    sample: "gudang-inventory"
  }
};

const RECENT = [
  { name: "kopikita-dashboard", archetype: "SaaS Dashboard", artifacts: 10, sync: "2h ago", status: "synced" },
  { name: "warung-pos", archetype: "API Service", artifacts: 11, sync: "1d ago", status: "drift", driftCount: 2 },
  { name: "tanya-legal-bot", archetype: "RAG Chatbot", artifacts: 17, sync: "3d ago", status: "synced" },
  { name: "gudang-inventory", archetype: "API Service", artifacts: 9, sync: "12d ago", status: "stale" }
];

const ARTIFACTS = {
  "constitution.md": {
    phase: "constitution",
    title: "constitution.md",
    note: "5 principles · governs every artifact downstream",
    body: `# KONSTITUSI — kopikita-dashboard

Prinsip non-negotiable. Setiap artifact di hilir
(PRD, arsitektur, kontrak, prompt) WAJIB patuh.

<b>1. SERVER-FIRST</b>
Semua pembacaan data lewat Server Components atau Route
Handlers. Tidak ada fetch data sensitif dari client.

<b>2. TYPES ARE LAW</b>
Tipe hanya boleh lahir dari skema Drizzle.
<span class="dm">const</span> <span class="lm">type Outlet</span> = typeof outlets.$inferSelect;
Larangan <span class="am">any</span> ditegakkan oleh ESLint rule no-explicit-any (error).

<b>3. RLS EVERYWHERE</b>
Setiap tabel Supabase wajib punya kebijakan RLS sebelum
dipakai. Migration tanpa policy = CI gagal.

<b>4. CONTRACTS BEFORE CODE</b>
Perubahan endpoint/skema dimulai dari openapi.yaml /
schema.ts, lalu regenerasi client types. Dilarang
mengubah bentuk response langsung di handler.

<b>5. CORPUS OVER CONTEXT</b>
Pengetahuan domain (SOP, dokumentasi) tinggal di RAG corpus —
bukan ditempel ke prompt. Prompt hanya membawa aturan,
bukan pengetahuan.`
  },

  "prd.md": {
    phase: "requirements",
    title: "prd.md",
    note: "Kopi Kita · multi-outlet ops dashboard",
    body: `# PRD — kopikita-dashboard v0.1

## Masalah
Owner jaringan kedai kopi (7 outlet) tidak punya satu
tempat untuk melihat penjualan harian, shift barista, dan
stok H-1. Data tersebar di Excel per outlet.

## Pengguna
<b>Owner</b>      — lihat ringkasan lintas outlet, ekspor laporan bulanan.
<b>Manager</b>   — input target harian, approve shift swap.
<b>Barista</b>   — clock-in/out, lihat target pribadi.

## User stories (potongan)
<span class="dm">US-01</span> Sebagai owner, saya melihat omzet gabungan 7 outlet hari ini
        begitu login, agar saya tahu kesehatan bisnis dalam 5 detik.
<span class="dm">US-04</span> Sebagai manager, saya meng-approve shift swap dengan satu klik,
        agar jadwal tidak bolong saat rush hour.
<span class="dm">US-07</span> Sebagai owner, saya mengekspor rekap P&L bulanan (CSV),
        agar pembukuan pajak tidak manual.

## Non-goals
Payroll, kasir POS, aplikasi pelanggan.`
  },

  "architecture.md": {
    phase: "architecture",
    title: "architecture.md",
    note: "Hulu → hilir · 4 layers · 14 files affected",
    flow: [
      { name: "Client — Next.js App Router", meta: "RSC + server actions" },
      { name: "Edge — Route Handlers /api/*", meta: "zod validated" },
      { name: "Services — domain modules", meta: "outlets · sales · shifts" },
      { name: "Data — Supabase Postgres + Auth + Storage", meta: "RLS enforced · drizzle" }
    ],
    body: `Arus data hulu → hilir tunggal; tidak ada jalur pintas
client → database. Kontrak tiap panah tercatat di 04/.`
  },

  "folder-map.txt": {
    phase: "architecture",
    title: "folder-map.txt",
    note: "Struktur direktori turunan arsitektur",
    body: `kopikita-dashboard/
├── app/
│   ├── (auth)/login/            <span class="dm"># server-first auth screens</span>
│   ├── dashboard/
│   │   ├── page.tsx             <span class="lm"># omzet gabungan, 5 detik pertama</span>
│   │   └── outlets/[id]/page.tsx
│   └── api/
│       ├── sales/route.ts       <span class="dm"># GET · zod · contract-bound</span>
│       └── shifts/route.ts
├── services/
│   ├── sales.service.ts
│   ├── shifts.service.ts
│   └── reports.service.ts
├── db/
│   ├── schema.ts                <span class="am">// ← sumber tipe (drizzle)</span>
│   └── migrations/
├── corpus/                      <span class="lm"># RAG corpus, di-ingest ke pgvector</span>
│   ├── manifest.json
│   └── chunks/*.md
├── AGENTS.md · CLAUDE.md        <span class="dm"># prompt layer</span>
└── constitution.md`
  },

  "openapi.yaml": {
    phase: "contracts",
    title: "openapi.yaml",
    note: "9 endpoints · semua response ter-contract",
    body: `<span class="dm">paths:</span>
  /outlets/{id}/sales:
    get:
      summary: Penjualan harian satu outlet
      parameters:
        - name: id     <span class="dm">in: path</span>   required: true
        - name: from   <span class="dm">in: query</span> schema: date
        - name: to     <span class="dm">in: query</span> schema: date
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items: $ref: "#/components/schemas/SalesDay"

<span class="dm">components:</span>
  schemas:
    SalesDay:
      type: object
      required: [date, gross, net, tx_count]
      properties:
        date:     { type: string, format: date }
        gross:    { type: integer }   <span class="dm"># rupiah, tanpa desimal</span>
        net:      { type: integer }
        tx_count: { type: integer }`
  },

  "schema.ts": {
    phase: "contracts",
    title: "schema.ts",
    note: "Drizzle source of truth untuk semua tipe",
    drifted: true,
    driftNote: "kode berubah setelah generasi — kolom payment_method ditambah manual di migrasi",
    driftTime: "2026-08-25 18:40",
    diff: [
      { sign: "-", kind: "del", code: '  paymentChannel: text("payment_channel")' },
      { sign: "+", kind: "add", code: '  paymentMethod: text("payment_method").notNull()' }
    ],
    body: `<span class="dm">import</span> { pgTable, uuid, integer, date, text } <span class="dm">from</span> "drizzle-orm/pg-core";

<span class="lm">export const outlets</span> = pgTable("outlets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  cityCode: text("city_code").notNull(),
});

<span class="lm">export const salesDaily</span> = pgTable("sales_daily", {
  id: uuid("id").primaryKey().defaultRandom(),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id),
  date: date("date").notNull(),
  gross: integer("gross").notNull(),
  net: integer("net").notNull(),
  txCount: integer("tx_count").notNull(),
});`
  },

  "AGENTS.md": {
    phase: "prompts",
    title: "AGENTS.md",
    note: "Sistem prompt induk · dibaca Codex/Cursor/Windsurf native",
    body: `<b># AGENTS — kopikita-dashboard</b>

Anda bekerja pada kodebase yang diatur oleh constitution.md.
Baca dulu: constitution.md → prd.md → architecture.md.
Jika sebuah keputusan bertentangan dengan konstitusi,
konstitusi yang menang. Ajukan keberatan, jangan diam-diam.

<b>ATURAN KERAS</b>
1. Tipe hanya dari db/schema.ts (prinsip 2).
2. Endpoint baru = tulis openapi.yaml dulu, regenerate
   client, baru tulis handler (prinsip 4).
3. Pertanyaan domain ("berapa shift ideal?") dijawab dari
   corpus via tool search_corpus — BUKAN dari ingatan Anda.
4. Sebelum commit: npm run validate wajib hijau.

<b>PERINTAH</b>
npm run dev · build · test · validate
npx drizzle-kit generate   <span class="dm"># setelah edit schema.ts</span>

<b>LARANGAN</b>
Tidak ada console.log tertinggal. Tidak ada any.
Tidak membuat file migration tanpa skema.`,

  },

  "CLAUDE.md": {
    phase: "prompts",
    title: "CLAUDE.md",
    note: "Shim tipis · satu sumber kebenaran di AGENTS.md",
    body: `<span class="dm"># CLAUDE.md</span>

@AGENTS.md

Ikuti AGENTS.md sebagai instruksi operasional penuh.
File ini hanya shim — sunting AGENTS.md, bukan file ini.`
  },

  "corpus-manifest.json": {
    phase: "corpus",
    title: "corpus-manifest.json",
    note: "128 chunks · siap di-ingest · embed: text-embedding-3-small",
    targets: ["supabase-pgvector", "archon-mcp", "custom-mcp"],
    body: `<span class="dm">{</span>
  <span class="lm">"project"</span>: "kopikita-dashboard",
  <span class="lm">"embed_model"</span>: "text-embedding-3-small",
  <span class="lm">"chunk_size"</span>: 800, <span class="lm">"overlap"</span>: 120,
  <span class="lm">"sources"</span>: [
    { <span class="lm">"id"</span>: "sop-shift-swap",   <span class="lm">"type"</span>: "internal-doc",
      <span class="lm">"chunks"</span>: 18,  <span class="lm">"tokens"</span>: 12400 },
    { <span class="lm">"id"</span>: "menu-engineering",  <span class="lm">"type"</span>: "internal-doc",
      <span class="lm">"chunks"</span>: 22,  <span class="lm">"tokens"</span>: 15900 },
    { <span class="lm">"id"</span>: "supabase-rls-guide", <span class="lm">"type"</span>: "vendor-docs",
      <span class="lm">"chunks"</span>: 31,  <span class="lm">"tokens"</span>: 24800 },
    { <span class="lm">"id"</span>: "nextjs15-caching",   <span class="lm">"type"</span>: "vendor-docs",
      <span class="lm">"chunks"</span>: 27,  <span class="lm">"tokens"</span>: 21300 },
    { <span class="lm">"id"</span>: "tax-recap-sop",      <span class="lm">"type"</span>: "internal-doc",
      <span class="lm">"chunks"</span>: 30,  <span class="lm">"tokens"</span>: 18700 }
  ],
  <span class="lm">"total_chunks"</span>: 128,
  <span class="lm">"total_tokens"</span>: 93100
<span class="dm">}</span>`
  },

  "export-manifest.json": {
    phase: "export",
    title: "export-manifest.json",
    note: "Kompatibel speckit + shim per tool",
    body: `<span class="dm">{</span>
  <span class="lm">"bundle"</span>: "speckit-compatible",
  <span class="lm">"files"</span>: [
    <span class="lm">".specify/constitution.md"</span>,
    <span class="lm">"specs/kopikita/spec.md"</span>,      <span class="dm"># dari prd.md</span>
    <span class="lm">"specs/kopikita/plan.md"</span>,      <span class="dm"># dari architecture.md</span>
    <span class="lm">"AGENTS.md"</span>, <span class="lm">"CLAUDE.md"</span>,
    <span class="lm">".cursor/rules/keel.mdc"</span>,
    <span class="lm">".github/copilot-instructions.md"</span>
  ],
  <span class="lm">"command"</span>: "keel export kopikita-dashboard --target speckit --zip"
<span class="dm">}</span>`
  }
};

const GEN_TIMINGS = [700, 850, 1100, 900, 1000, 1400, 600];
