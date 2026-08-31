import type { PublicLocale, PublicPageId } from "./public-site-config.js";

const homepageVisualCopy: Record<PublicLocale, { alt: string; caption: string }> = {
  en: {
    alt: "Tactile model of an order moving through connected systems, an approval checkpoint, and a completed delivery.",
    caption: "INPUT · CONNECT · REVIEW · COMPLETE",
  },
  de: {
    alt: "Greifbares Modell eines Auftrags, der durch verbundene Systeme, eine Freigabe und bis zum Ergebnis läuft.",
    caption: "EINGANG · VERBINDEN · PRÜFEN · ABSCHLIESSEN",
  },
  tr: {
    alt: "Bir siparişin bağlı sistemlerden, onay noktasından ve tamamlanmış teslimata ilerlediğini gösteren fiziksel model.",
    caption: "GİRDİ · BAĞLANTI · İNCELEME · TAMAMLAMA",
  },
};

export function renderHomepageSystemVisual(locale: PublicLocale = "en") {
  const copy = homepageVisualCopy[locale];
  return `<figure class="v4-system-visual"><img src="/assets/site/connected-business-system.png" width="1729" height="910" alt="${copy.alt}" loading="eager" decoding="async"><figcaption>${copy.caption}</figcaption></figure>`;
}

type ConnectedExample = {
  label: string;
  title: string;
  quote: string;
  trigger: string;
  connections: string;
  control: string;
  outcome: string;
  flow: string[];
};

type ConnectedExampleCopy = {
  labels: [string, string, string, string];
  note: string;
  items: ConnectedExample[];
};

const connectedExampleCopy: Record<PublicLocale, ConnectedExampleCopy> = {
  en: {
    labels: ["Trigger", "Connections", "Decision hook", "Outcome"],
    note: "Representative real-world delivery scenarios. Exact systems, permissions, and approval points are defined for each project.",
    items: [
      {
        label: "B2B ORDERING",
        title: "From customer request to a confirmed ERP order.",
        quote: "An approved customer submits a mixed-stock order through the portal.",
        trigger: "Order submitted in the B2B portal",
        connections: "Customer portal · Product catalogue · Pricing rules · ERP · Email",
        control: "Credit or stock exceptions pause for sales approval",
        outcome: "Confirmed order, ERP record, and customer reply",
        flow: ["Portal", "Price + stock", "Sales review", "ERP", "Confirmation"],
      },
      {
        label: "LEGACY RENEWAL",
        title: "Move records without gambling the working day.",
        quote: "A validated migration batch replaces one controlled slice of the old system.",
        trigger: "Approved batch starts from a read-only snapshot",
        connections: "Legacy database · Mapping service · Exception queue · New application · Backup",
        control: "Ambiguous records and cutover wait for an owner",
        outcome: "Validated data, decision history, and rollback path",
        flow: ["Snapshot", "Map", "Validate", "Owner decision", "Release"],
      },
      {
        label: "MARKET MONITORING",
        title: "Turn a daily search into a sourced review queue.",
        quote: "New public opportunities are collected, matched, and routed before the team starts work.",
        trigger: "A daily schedule checks approved sources",
        connections: "APIs · Feeds · Browser sources · Matching rules · CRM · Email",
        control: "Uncertain matches stay in human review",
        outcome: "Ranked opportunity with source, reason, and next action",
        flow: ["Sources", "Collect", "Match", "Review", "CRM + alert"],
      },
    ],
  },
  de: {
    labels: ["Auslöser", "Verbindungen", "Freigabepunkt", "Ergebnis"],
    note: "Repräsentative Szenarien aus realen Geschäftsabläufen. Systeme, Berechtigungen und Freigabepunkte werden je Projekt konkret festgelegt.",
    items: [
      {
        label: "B2B-BESTELLUNG",
        title: "Von der Kundenanfrage zum bestätigten ERP-Auftrag.",
        quote: "Ein freigeschalteter Kunde gibt im Portal eine Bestellung mit gemischtem Lagerbestand auf.",
        trigger: "Bestellung im B2B-Portal abgesendet",
        connections: "Kundenportal · Produktkatalog · Preisregeln · ERP · E-Mail",
        control: "Kredit- oder Bestandsausnahmen warten auf den Vertrieb",
        outcome: "Bestätigter Auftrag, ERP-Datensatz und Kundenantwort",
        flow: ["Portal", "Preis + Bestand", "Vertrieb", "ERP", "Bestätigung"],
      },
      {
        label: "ALTSYSTEM-ABLÖSUNG",
        title: "Datensätze migrieren, ohne den Arbeitstag zu riskieren.",
        quote: "Ein geprüftes Migrationspaket ersetzt einen kontrollierten Teil des Altsystems.",
        trigger: "Freigegebenes Paket startet aus einem Nur-Lese-Snapshot",
        connections: "Altdatenbank · Zuordnungsdienst · Ausnahmeliste · Neue Anwendung · Sicherung",
        control: "Unklare Datensätze und Umstellung warten auf Verantwortliche",
        outcome: "Geprüfte Daten, Entscheidungsverlauf und Rückfallweg",
        flow: ["Snapshot", "Zuordnen", "Prüfen", "Entscheidung", "Freigabe"],
      },
      {
        label: "MARKTMONITORING",
        title: "Aus täglicher Suche wird eine belegte Prüfliste.",
        quote: "Neue öffentliche Chancen werden erfasst, abgeglichen und vor Arbeitsbeginn an das Team geleitet.",
        trigger: "Ein Tagesplan prüft freigegebene Quellen",
        connections: "APIs · Feeds · Browserquellen · Abgleichregeln · CRM · E-Mail",
        control: "Unsichere Treffer bleiben in menschlicher Prüfung",
        outcome: "Priorisierte Chance mit Quelle, Auswahlgrund und nächstem Schritt",
        flow: ["Quellen", "Erfassen", "Abgleichen", "Prüfen", "CRM + Hinweis"],
      },
    ],
  },
  tr: {
    labels: ["Tetikleyici", "Bağlantılar", "Karar noktası", "Sonuç"],
    note: "Gerçek iş akışlarını temsil eden uygulama senaryoları. Sistemler, yetkiler ve onay noktaları her proje için ayrıca belirlenir.",
    items: [
      {
        label: "B2B SİPARİŞ",
        title: "Müşteri talebinden onaylanmış ERP siparişine.",
        quote: "Onaylı müşteri, portal üzerinden farklı stok durumlarına sahip ürünleri sipariş eder.",
        trigger: "B2B portalında sipariş gönderilir",
        connections: "Müşteri portalı · Ürün kataloğu · Fiyat kuralları · ERP · E-posta",
        control: "Kredi veya stok istisnaları satış onayını bekler",
        outcome: "Onaylı sipariş, ERP kaydı ve müşteri yanıtı",
        flow: ["Portal", "Fiyat + stok", "Satış onayı", "ERP", "Onay"],
      },
      {
        label: "ESKİ SİSTEM YENİLEME",
        title: "Günlük işi riske atmadan kayıtları taşıyın.",
        quote: "Doğrulanmış geçiş paketi, eski sistemin kontrollü bir bölümünün yerini alır.",
        trigger: "Onaylı paket salt okunur anlık görüntüyle başlar",
        connections: "Eski veritabanı · Eşleme hizmeti · İstisna kuyruğu · Yeni uygulama · Yedek",
        control: "Belirsiz kayıtlar ve canlıya geçiş sorumlu kişiyi bekler",
        outcome: "Doğrulanmış veri, karar geçmişi ve geri dönüş yolu",
        flow: ["Anlık görüntü", "Eşleme", "Doğrulama", "Sorumlu kararı", "Yayın"],
      },
      {
        label: "PAZAR İZLEME",
        title: "Günlük aramayı kaynaklı bir inceleme kuyruğuna dönüştürün.",
        quote: "Yeni kamu fırsatları ekip işe başlamadan toplanır, eşleştirilir ve yönlendirilir.",
        trigger: "Günlük zamanlama onaylı kaynakları kontrol eder",
        connections: "API · Veri akışı · Tarayıcı kaynakları · Eşleme kuralları · CRM · E-posta",
        control: "Belirsiz eşleşmeler insan incelemesinde kalır",
        outcome: "Kaynağı, seçilme nedeni ve sonraki adımı belli fırsat",
        flow: ["Kaynaklar", "Toplama", "Eşleme", "İnceleme", "CRM + bildirim"],
      },
    ],
  },
};

export function renderConnectedExamples(locale: PublicLocale = "en") {
  const copy = connectedExampleCopy[locale];
  const cards = copy.items.map((item) => `<article class="real-example-card"><header><p class="section-index">${item.label}</p><h3>${item.title}</h3></header><blockquote>“${item.quote}”</blockquote><ol class="real-system-flow" aria-label="${item.title}">${item.flow.map((step) => `<li>${step}</li>`).join("")}</ol><dl class="example-hooks"><div><dt>${copy.labels[0]}</dt><dd>${item.trigger}</dd></div><div><dt>${copy.labels[1]}</dt><dd>${item.connections}</dd></div><div><dt>${copy.labels[2]}</dt><dd>${item.control}</dd></div><div><dt>${copy.labels[3]}</dt><dd>${item.outcome}</dd></div></dl></article>`).join("");
  return `<div class="real-example-grid">${cards}</div><p class="real-example-note">${copy.note}</p>`;
}

type SolutionVisualId = "websites-commerce" | "business-systems" | "opportunity-intelligence" | "web-data-monitoring" | "automation";
type SolutionVisual = { title: string; nodes: string[] };
type SolutionVisualCopy = { label: string; intro: string; note: string; imageAlt: string; maps: Record<SolutionVisualId, SolutionVisual> };

const solutionVisualCopy: Record<PublicLocale, SolutionVisualCopy> = {
  en: {
    label: "CONNECTED SYSTEM VIEW",
    intro: "The useful system is the whole path: trigger, software, data, decision points, outcome, and a way to recover.",
    note: "Illustrative architecture. Exact providers, data paths, permissions, review rules, and recovery steps are agreed during Project Discovery.",
    imageAlt: "Tactile model of a legacy data system moving through mapping, validation, review, a modern application, and a rollback path.",
    maps: {
      "websites-commerce": { title: "Connect the customer journey to the work behind it.", nodes: ["Customer request", "Portal", "Product + price rules", "Payment / ERP", "Operations review", "Live service"] },
      "business-systems": { title: "Modernize in stages, with a visible way back.", nodes: ["Read-only source", "Mapping", "Validation", "Owner review", "New system", "Rollback"] },
      "opportunity-intelligence": { title: "Keep every surfaced opportunity tied to its source and reason.", nodes: ["Approved sources", "Daily trigger", "Normalize", "Match", "Human review", "CRM + alerts"] },
      "web-data-monitoring": { title: "Separate source collection from the stable business output.", nodes: ["API / feed / browser", "Schedule", "Collect", "Validate", "Provenance store", "Export + alert"] },
      automation: { title: "Move the process across tools without hiding the decisions.", nodes: ["Email + documents", "Trigger", "Rules", "Agent work", "Approval", "ERP / CRM", "History"] },
    },
  },
  de: {
    label: "ANSICHT DES VERBUNDENEN SYSTEMS",
    intro: "Das nutzbare System umfasst den gesamten Weg: Auslöser, Software, Daten, Entscheidungspunkte, Ergebnis und Wiederherstellung.",
    note: "Illustrative Architektur. Anbieter, Datenwege, Berechtigungen, Prüfrichtlinien und Wiederherstellung werden in der Projektklärung festgelegt.",
    imageAlt: "Greifbares Modell eines Altsystems auf dem Weg durch Zuordnung, Validierung, Prüfung, neue Anwendung und Rückfallweg.",
    maps: {
      "websites-commerce": { title: "Die Kundenreise mit der Arbeit dahinter verbinden.", nodes: ["Kundenanfrage", "Portal", "Produkt + Preisregeln", "Zahlung / ERP", "Betriebsprüfung", "Live-System"] },
      "business-systems": { title: "Schrittweise modernisieren – mit sichtbarem Rückweg.", nodes: ["Nur-Lese-Quelle", "Zuordnung", "Validierung", "Verantwortliche Prüfung", "Neues System", "Rückfall"] },
      "opportunity-intelligence": { title: "Jede Chance behält Quelle und Auswahlgrund.", nodes: ["Freigegebene Quellen", "Tagesauslöser", "Strukturieren", "Abgleichen", "Menschliche Prüfung", "CRM + Hinweise"] },
      "web-data-monitoring": { title: "Quellenerfassung vom stabilen Geschäftsergebnis trennen.", nodes: ["API / Feed / Browser", "Zeitplan", "Erfassen", "Validieren", "Herkunftsspeicher", "Export + Hinweis"] },
      automation: { title: "Den Prozess über Werkzeuge hinweg bewegen, ohne Entscheidungen zu verstecken.", nodes: ["E-Mail + Dokumente", "Auslöser", "Regeln", "Agentenarbeit", "Freigabe", "ERP / CRM", "Verlauf"] },
    },
  },
  tr: {
    label: "BAĞLI SİSTEM GÖRÜNÜMÜ",
    intro: "Kullanışlı sistem yolun tamamıdır: tetikleyici, yazılım, veri, karar noktaları, sonuç ve kurtarma yolu.",
    note: "Temsili mimari. Sağlayıcılar, veri yolları, yetkiler, inceleme kuralları ve kurtarma adımları Proje Keşfi sırasında belirlenir.",
    imageAlt: "Eski veri sisteminin eşleme, doğrulama, inceleme, yeni uygulama ve geri dönüş yolundan geçişini gösteren fiziksel model.",
    maps: {
      "websites-commerce": { title: "Müşteri yolculuğunu arka plandaki işle bağlayın.", nodes: ["Müşteri talebi", "Portal", "Ürün + fiyat kuralları", "Ödeme / ERP", "Operasyon incelemesi", "Canlı sistem"] },
      "business-systems": { title: "Görünür bir geri dönüş yoluyla aşamalı yenileme.", nodes: ["Salt okunur kaynak", "Eşleme", "Doğrulama", "Sorumlu incelemesi", "Yeni sistem", "Geri dönüş"] },
      "opportunity-intelligence": { title: "Her fırsat kaynağını ve gösterilme nedenini korur.", nodes: ["Onaylı kaynaklar", "Günlük tetikleyici", "Yapılandırma", "Eşleme", "İnsan incelemesi", "CRM + bildirim"] },
      "web-data-monitoring": { title: "Kaynak toplamayı kararlı iş sonucundan ayırın.", nodes: ["API / akış / tarayıcı", "Zamanlama", "Toplama", "Doğrulama", "Kaynak kaydı", "Dışa aktarım + bildirim"] },
      automation: { title: "Kararları gizlemeden süreci araçlar arasında ilerletin.", nodes: ["E-posta + belgeler", "Tetikleyici", "Kurallar", "Ajan çalışması", "Onay", "ERP / CRM", "Geçmiş"] },
    },
  },
};

export function renderSolutionVisual(pageId: PublicPageId, locale: PublicLocale = "en") {
  const copy = solutionVisualCopy[locale];
  const map = copy.maps[pageId as SolutionVisualId];
  if (!map) return "";
  const image = pageId === "business-systems" ? `<img class="solution-map-image" src="/assets/site/legacy-modernization.png" width="1661" height="947" alt="${copy.imageAlt}" loading="lazy" decoding="async">` : "";
  return `<section class="section solution-visual-section" aria-labelledby="solution-visual-title"><div><p class="section-index">${copy.label}</p><h2 id="solution-visual-title">${map.title}</h2><p class="section-lead">${copy.intro}</p></div><figure class="solution-map-visual ${image ? "has-image" : ""}">${image}<ol class="solution-system-flow" aria-label="${map.title}">${map.nodes.map((node, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><strong>${node}</strong></li>`).join("")}</ol><figcaption>${copy.note}</figcaption></figure></section>`;
}
