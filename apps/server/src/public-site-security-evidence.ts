import { escapeHtml, publicRepoUrl, type PublicLocale } from "./public-site-config.js";

type SecurityDocument = { path: string; title: string; text: string };
type SecurityEvidenceCopy = { label: string; heading: string; intro: string; documents: SecurityDocument[]; repo: string };

const securityEvidenceCopy: Record<PublicLocale, SecurityEvidenceCopy> = {
  en: {
    label: "SECURITY FILES",
    heading: "Inspect the files behind the security claims.",
    intro: "These maintained public documents define reporting, authorization boundaries, public/private separation, and the latest dependency review.",
    documents: [
      { path: "SECURITY.md", title: "Security policy & reporting", text: "Supported versions, responsible vulnerability reporting, and deployment responsibilities." },
      { path: "docs/route-security-matrix.md", title: "Route authorization matrix", text: "Public bootstrap, owner-scoped, and admin-only API surfaces with their enforcement points." },
      { path: "docs/public-private-repository-boundary.md", title: "Public/private boundary", text: "What belongs in the open-source core and what must stay in private deployment state." },
      { path: "docs/dependency-security-review-2026-08-26.md", title: "Dependency security review", text: "A dated remediation record, audit result, validation gates, and rollback expectations." },
    ],
    repo: "Browse all security documentation",
  },
  de: {
    label: "SICHERHEITSDATEIEN",
    heading: "Prüfen Sie die Dateien hinter den Sicherheitsangaben.",
    intro: "Diese gepflegten öffentlichen Dokumente definieren Meldewege, Berechtigungsgrenzen, die Trennung von öffentlichen und privaten Daten sowie die aktuelle Abhängigkeitsprüfung.",
    documents: [
      { path: "SECURITY.md", title: "Sicherheitsrichtlinie & Meldung", text: "Unterstützte Versionen, verantwortliche Schwachstellenmeldung und Betriebsverantwortung." },
      { path: "docs/route-security-matrix.md", title: "Berechtigungsmatrix der Routen", text: "Öffentliche, eigentümerbezogene und reine Admin-APIs mit ihren technischen Prüfpunkten." },
      { path: "docs/public-private-repository-boundary.md", title: "Öffentliche und private Grenze", text: "Was in den Open-Source-Kern gehört und was in privaten Bereitstellungsdaten bleiben muss." },
      { path: "docs/dependency-security-review-2026-08-26.md", title: "Prüfung der Abhängigkeitssicherheit", text: "Datierter Behebungsnachweis, Audit-Ergebnis, Prüfgates und Rückfallerwartungen." },
    ],
    repo: "Alle Sicherheitsdokumente ansehen",
  },
  tr: {
    label: "GÜVENLİK DOSYALARI",
    heading: "Güvenlik bilgilerinin dayandığı dosyaları inceleyin.",
    intro: "Bakımı yapılan bu açık belgeler; bildirim yolunu, yetki sınırlarını, açık ve özel verinin ayrımını ve son bağımlılık incelemesini tanımlar.",
    documents: [
      { path: "SECURITY.md", title: "Güvenlik politikası ve bildirim", text: "Desteklenen sürümler, sorumlu güvenlik açığı bildirimi ve kurulum sorumlulukları." },
      { path: "docs/route-security-matrix.md", title: "Rota yetkilendirme matrisi", text: "Herkese açık, kullanıcı kapsamlı ve yalnızca yönetici API yüzeyleri ile denetim noktaları." },
      { path: "docs/public-private-repository-boundary.md", title: "Açık ve özel veri sınırı", text: "Açık kaynak çekirdeğe girebilecek veriler ile özel kurulum durumunda kalması gerekenler." },
      { path: "docs/dependency-security-review-2026-08-26.md", title: "Bağımlılık güvenliği incelemesi", text: "Tarihli düzeltme kaydı, denetim sonucu, doğrulama kontrolleri ve geri dönüş beklentileri." },
    ],
    repo: "Tüm güvenlik belgelerini görüntüleyin",
  },
};

export function renderSecurityDocumentEvidence(locale: PublicLocale = "en", env = process.env) {
  const copy = securityEvidenceCopy[locale];
  const repo = publicRepoUrl(env).replace(/\/+$/, "");
  const cards = copy.documents.map((document) => {
    const href = `${repo}/blob/main/${document.path}`;
    return `<a class="security-document-card" href="${escapeHtml(href)}" rel="noreferrer" data-event="security_document_click"><code>${document.path}</code><strong>${document.title}</strong><span>${document.text}</span></a>`;
  }).join("");
  return `<section class="section security-evidence" aria-labelledby="evidence-title"><div><p class="section-index">${copy.label}</p><h2 id="evidence-title">${copy.heading}</h2><p class="section-lead">${copy.intro}</p></div><div class="evidence-panel"><div class="security-document-grid">${cards}</div><a class="button button-outline" href="${escapeHtml(`${repo}/tree/main/docs`)}" rel="noreferrer" data-event="security_github_click">${copy.repo}</a></div></section>`;
}
