import { escapeHtml, type PublicLocale, type PublicPageId } from "./public-site-config.js";

type FaqSource = {
  id: PublicPageId;
  proofText: string;
  boundaries: string[];
  stages: Array<[string, string]>;
};
type ServiceId = "websites-commerce" | "business-systems" | "opportunity-intelligence" | "web-data-monitoring" | "automation";

const questions: Record<PublicLocale, Record<ServiceId, [string, string, string]>> = {
  en: {
    "websites-commerce": ["Does my website or portal need AI?", "Who operates the website after launch?", "How are scope and integrations agreed?"],
    "business-systems": ["Does modernization mean replacing the whole system?", "How is data migration planned?", "How are production access and cutover handled?"],
    "opportunity-intelligence": ["Which opportunity sources can be monitored?", "Why was an opportunity selected?", "Does matching guarantee eligibility or a successful proposal?"],
    "web-data-monitoring": ["How is web data collected?", "What happens when a source changes?", "Which sources can be used?"],
    automation: ["How does a workflow automation project start?", "Where do people review automated work?", "Which connections are available to a workflow?"],
  },
  de: {
    "websites-commerce": ["Braucht meine Website oder mein Portal KI?", "Wer betreibt die Website nach dem Start?", "Wie werden Umfang und Integrationen vereinbart?"],
    "business-systems": ["Muss bei der Modernisierung das gesamte System ersetzt werden?", "Wie wird die Datenmigration geplant?", "Wie werden Produktivzugriff und Umstellung geregelt?"],
    "opportunity-intelligence": ["Welche Quellen lassen sich auf Geschäftschancen überwachen?", "Warum wurde eine Geschäftschance ausgewählt?", "Garantiert der Abgleich die Eignung oder einen Zuschlag?"],
    "web-data-monitoring": ["Wie werden Web-Daten erfasst?", "Was passiert, wenn sich eine Quelle ändert?", "Welche Quellen dürfen verwendet werden?"],
    automation: ["Wie beginnt ein Automatisierungsprojekt?", "Wo prüfen Menschen die automatisierte Arbeit?", "Welche Verbindungen stehen einem Workflow zur Verfügung?"],
  },
  tr: {
    "websites-commerce": ["Web sitem veya portalım için yapay zekâ gerekli mi?", "Web sitesi yayına alındıktan sonra nasıl işletilir?", "Kapsam ve entegrasyonlar nasıl belirlenir?"],
    "business-systems": ["Modernizasyon tüm sistemi değiştirmek anlamına mı gelir?", "Veri geçişi nasıl planlanır?", "Canlı erişim ve geçiş onayı nasıl ele alınır?"],
    "opportunity-intelligence": ["İş fırsatları için hangi kaynaklar izlenebilir?", "Bir fırsatın neden seçildiğini görebilir miyim?", "Eşleştirme uygunluk veya başarı garantisi verir mi?"],
    "web-data-monitoring": ["Web verisi nasıl toplanır?", "Bir kaynak değiştiğinde ne olur?", "Hangi kaynaklar kullanılabilir?"],
    automation: ["İş akışı otomasyonu projesi nasıl başlar?", "Otomatikleştirilen işlerde insan incelemesi nerede devreye girer?", "Bir iş akışı hangi bağlantıları kullanabilir?"],
  },
};
const headings: Record<PublicLocale, string> = {
  en: "Frequently asked questions", de: "Häufige Fragen", tr: "Sık sorulan sorular",
};

// Answers reuse the approved service definition in its own language verbatim.
// Keep new claims, customer evidence and delivery promises out of this renderer.
function answers(source: FaqSource): string[][] {
  const { proofText, boundaries: b, stages: s } = source;
  switch (source.id) {
    case "websites-commerce": return [[proofText], [s[3][1], b[0]], [b[2]]];
    case "business-systems": return [[proofText], [s[2][1], b[0]], [b[1], s[3][1]]];
    case "opportunity-intelligence": return [[b[0], b[1]], [proofText], [b[2]]];
    case "web-data-monitoring": return [[s[1][1]], [s[2][1], s[3][1], b[2]], [b[0], b[1]]];
    case "automation": return [[s[0][1], s[2][1]], [s[1][1], b[1], b[2]], [b[0]]];
    default: return [];
  }
}

export function renderSolutionFaq(source: FaqSource, locale: PublicLocale = "en"): string {
  const entries = answers(source);
  if (!entries.length) return "";
  const prompts = questions[locale][source.id as ServiceId];
  return `<section class="section faq solution-faq" aria-labelledby="solution-faq-title"><div><h2 id="solution-faq-title">${headings[locale]}</h2></div><div class="faq-list">${entries.map((paragraphs, index) =>
    `<details><summary>${escapeHtml(prompts[index])}</summary>${paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join("")}</details>`
  ).join("")}</div></section>`;
}
