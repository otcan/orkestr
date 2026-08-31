import { publicPagePath, type PublicLocale, type PublicPage } from "./public-site-config.js";
import { renderSecurityDocumentEvidence } from "./public-site-security-evidence.js";

type TrustCopy = {
  title: string; summary: string; eyebrow: string; heading: string; lead: string;
  sectionLabel: string; sectionHeading: string; cards: Array<[string, string]>;
  boundaryLabel: string; boundaryHeading: string; boundaries: Array<[string, string]>;
  limitLabel: string; limitHeading: string; limits: string[]; cta: string; book: string;
};

const securityCopy: Record<"de" | "tr", TrustCopy> = {
  de: {
    title: "Sicherheit & Zugriff bei Unternehmenssoftware", summary: "So begrenzt Orkestr Zugriffe, Verbindungen, Freigaben, Daten und Betriebsverantwortung in individuellen Software- und Automatisierungsprojekten.",
    eyebrow: "SICHERHEIT UND KONTROLLE", heading: "Ihre Systeme bleiben unter Ihrer Kontrolle.", lead: "Jedes Projekt beginnt mit klaren Nutzern, Daten, Quellen, Systemen, Berechtigungen, Verantwortlichkeiten und Betriebsgrenzen.",
    sectionLabel: "DREI KONTROLLPRINZIPIEN", sectionHeading: "Kontrolle ist Teil des Systems – kein nachträglicher Zusatz.", cards: [["Private Umgebung", "Betrieb in einer dedizierten betreuten Umgebung oder in einer Infrastruktur, die Ihre Organisation kontrolliert."], ["Begrenzte Zugriffe", "Nur die für das Projekt freigegebenen Konten, Datenquellen und Systeme werden verbunden."], ["Menschliche Freigabe", "Wichtige, externe oder irreversible Aktionen können an definierten Punkten auf eine zuständige Person warten."]],
    boundaryLabel: "KLARE VERANTWORTUNG", boundaryHeading: "Vor dem Produktivbetrieb ist geklärt, wer was kontrolliert.", boundaries: [["Öffentlicher Kern", "Generischer Produktcode, Dokumentation, Tests und illustrative Beispiele."], ["Private Umgebung", "Zugangsdaten, reale Konfiguration, Sitzungen und operative Datensätze."], ["Kundensysteme", "Nur Informationen und Aktionen, die für den vereinbarten Projektumfang erforderlich sind."]],
    limitLabel: "PRÜFANFORDERUNGEN", limitHeading: "Sicherheitsanforderungen werden konkret geprüft und dokumentiert.", limits: ["Zertifizierungen und regulatorische Anforderungen werden je Bereitstellung bewertet und nur mit belastbaren Nachweisen dokumentiert.", "Identität, Aufbewahrung, Netzwerkrichtlinien, Backups und Wiederherstellung müssen für die gewählte Umgebung geprüft werden.", "Verfügbare Verbindungen und Produktionsreife unterscheiden sich je Projekt.", "Folgenreiche Ergebnisse und Aktionen benötigen eine angemessene menschliche Prüfung."],
    cta: "Möchten Sie das Zugriffsmodell für Ihr Projekt prüfen?", book: "Projektgespräch buchen",
  },
  tr: {
    title: "İş Yazılımında Güvenlik ve Erişim", summary: "Orkestr'in özel yazılım ve otomasyon projelerinde erişimi, bağlantıları, onayları, veriyi ve işletim sorumluluğunu nasıl sınırlandırdığını görün.",
    eyebrow: "GÜVENLİK VE KONTROL", heading: "Sistemleriniz sizin kontrolünüzde kalır.", lead: "Her proje; kullanıcılar, veri, kaynaklar, sistemler, izinler, sorumluluklar ve işletim sınırları açıkça tanımlanarak başlar.",
    sectionLabel: "ÜÇ KONTROL İLKESİ", sectionHeading: "Kontrol sonradan eklenmez; sistemin bir parçasıdır.", cards: [["Özel ortam", "Orkestr, projeye özel yönetilen bir ortamda veya kuruluşunuzun kontrol ettiği altyapıda çalışır."], ["Sınırlı erişim", "Yalnızca proje için onaylanan hesaplar, veri kaynakları ve sistemler bağlanır."], ["İnsan onayı", "Önemli, dışa dönük veya geri alınamaz işlemler tanımlı noktalarda yetkili kişiyi bekleyebilir."]],
    boundaryLabel: "AÇIK SORUMLULUK", boundaryHeading: "Canlıya geçmeden önce kimin neyi kontrol ettiği bellidir.", boundaries: [["Açık kaynak çekirdek", "Genel ürün kodu, dokümantasyon, testler ve temsili örnekler."], ["Özel ortam", "Kimlik bilgileri, gerçek yapılandırma, oturumlar ve operasyon kayıtları."], ["Müşteri sistemleri", "Yalnızca kararlaştırılan proje kapsamı için gereken bilgi ve işlemler."]],
    limitLabel: "İNCELEME GEREKSİNİMLERİ", limitHeading: "Güvenlik gereksinimleri somut biçimde değerlendirilir ve belgelenir.", limits: ["Sertifikalar ve mevzuat gereksinimleri her kurulum için değerlendirilir ve yalnızca doğrulanabilir kanıtla belgelenir.", "Kimlik, saklama, ağ politikası, yedekleme ve kurtarma seçilen ortam için ayrıca değerlendirilmelidir.", "Kullanılabilen bağlantılar ve canlı ortam hazırlığı projeye göre değişir.", "Yüksek etkili sonuçlar ve işlemler uygun insan incelemesi gerektirir."],
    cta: "Projenizin erişim modelini birlikte değerlendirelim mi?", book: "Proje görüşmesi planla",
  },
};

const deploymentCopy: Record<"de" | "tr", TrustCopy> = {
  de: {
    title: "Bereitstellung & Betrieb individueller Software", summary: "So vereinbart Orkestr Produktionsumgebung, Verantwortlichkeiten, Einführung, Monitoring, Wartung, Zugriff und Rückfallplan für betreute Systeme.",
    eyebrow: "BEREITSTELLUNG UND BETRIEB", heading: "Wissen, wo das System läuft – und wer es am Laufen hält.", lead: "Das passende Produktionsmodell hängt vom Projekt ab. Umgebung, Daten, Identität, Releases, Monitoring, Support und Wiederherstellung werden vor dem Livebetrieb vereinbart.",
    sectionLabel: "ZWEI BETRIEBSMODELLE", sectionHeading: "Eine klare Umgebung für den vereinbarten Zweck.", cards: [["Betreute private Umgebung", "Orkestr richtet eine dedizierte Umgebung ein und betreibt sie gemeinsam mit Ihnen. Verbindungen und Entscheidungsregeln werden durch Ihr Team freigegeben."], ["Ihre Infrastruktur", "Das System läuft in einer von Ihrer Organisation kontrollierten Umgebung. Identitäts-, Netzwerk-, Backup- und Zugriffsrichtlinien bleiben bei Ihrem Team."], ["Geteilte Verantwortung", "Aufgaben, Reaktionswege, Wartungsfenster, Änderungen und Eskalation werden vor dem Produktivstart dokumentiert."]],
    boundaryLabel: "SCHRITTWEISE EINFÜHRUNG", boundaryHeading: "Vom abgegrenzten Projekt zur kontrollierten Produktion.", boundaries: [["01 · Zweck", "Ergebnis, Nutzer, Systeme, Grenzen und Erfolgskriterien festlegen."], ["02 · Verbindungen", "Nur notwendige Konten, Quellen und Dienste freigeben."], ["03 · Tests", "Normalfälle, Ausnahmen, Berechtigungen, Fehler und Wiederherstellung prüfen."], ["04 · Release", "Bewusst live gehen, überwachen und einen Rückfallweg erhalten."]],
    limitLabel: "VOR DEM START", limitHeading: "Betrieb ist Teil des Angebots.", limits: ["Produktionsverantwortung und Supportzeiten werden ausdrücklich vereinbart.", "Backups und Wiederherstellung werden passend zur Umgebung getestet.", "Änderungen durchlaufen einen sichtbaren Release- und Freigabeweg.", "Kundenspezifische Zugangsdaten und Konfiguration gehören nicht in den öffentlichen Quellcode."],
    cta: "Welches Betriebsmodell passt zu Ihrem Projekt?", book: "Projektgespräch buchen",
  },
  tr: {
    title: "Özel Yazılımı Devreye Alma ve İşletme", summary: "Orkestr'in yönetilen sistemlerde canlı ortamı, sorumlulukları, yayını, izlemeyi, bakımı, erişimi ve geri dönüş planını nasıl tanımladığını görün.",
    eyebrow: "DEVREYE ALMA VE İŞLETİM", heading: "Sistemin nerede çalıştığını ve kimin çalışır tuttuğunu bilin.", lead: "Doğru canlı ortam modeli geliştirilen sisteme bağlıdır. Ortam, veri, kimlik, yayın, izleme, destek ve kurtarma sorumlulukları canlı işletimden önce kararlaştırılır.",
    sectionLabel: "İKİ İŞLETİM MODELİ", sectionHeading: "Kararlaştırılan amaç için sınırları belli bir ortam.", cards: [["Yönetilen özel ortam", "Orkestr projeye özel ortamı kurar ve sizinle birlikte işletir. Bağlantıları ve karar kurallarını ekibiniz onaylar."], ["Sizin altyapınız", "Sistem kuruluşunuzun kontrol ettiği altyapıda çalışır. Kimlik, ağ, yedekleme ve erişim politikaları ekibinizin sorumluluğundadır."], ["Paylaşılan sorumluluk", "Görevler, müdahale yolları, bakım pencereleri, değişiklikler ve eskalasyon canlıya geçmeden belgelenir."]],
    boundaryLabel: "AŞAMALI DEVREYE ALMA", boundaryHeading: "Sınırları belli projeden kontrollü canlı işletime.", boundaries: [["01 · Amaç", "Sonuç, kullanıcılar, sistemler, sınırlar ve başarı ölçütleri belirlenir."], ["02 · Bağlantılar", "Yalnızca gerekli hesaplar, kaynaklar ve hizmetler onaylanır."], ["03 · Test", "Normal durumlar, istisnalar, izinler, hatalar ve kurtarma yolları doğrulanır."], ["04 · Yayın", "Sistem planlı biçimde canlıya alınır, izlenir ve geri dönüş yolu korunur."]],
    limitLabel: "CANLIYA GEÇMEDEN ÖNCE", limitHeading: "İşletim teklifin bir parçasıdır.", limits: ["Canlı ortam sorumluluğu ve destek saatleri açıkça kararlaştırılır.", "Yedekleme ve kurtarma seçilen ortama göre test edilir.", "Değişiklikler görünür bir yayın ve onay sürecinden geçer.", "Müşteriye özel kimlik bilgileri ve yapılandırma açık kaynak depoya girmez."],
    cta: "Projenize hangi işletim modeli uygun?", book: "Proje görüşmesi planla",
  },
};

export function localizedTrustPage(pageId: "security" | "deployment", locale: "de" | "tr", env = process.env): PublicPage {
  const copy = pageId === "security" ? securityCopy[locale] : deploymentCopy[locale];
  const evidence = pageId === "security" ? renderSecurityDocumentEvidence(locale, env) : "";
  return {
    id: pageId, locale, title: copy.title, summary: copy.summary, canonicalPath: publicPagePath(pageId, locale),
    body: `<main id="main-content"><section class="page-hero"><p class="section-index">${copy.eyebrow}</p><h1>${copy.heading}</h1><p class="lead">${copy.lead}</p></section><section class="section trust-section"><div class="section-heading"><p class="section-index">${copy.sectionLabel}</p><h2>${copy.sectionHeading}</h2></div><div class="trust-pillars">${copy.cards.map(([title, text], index) => `<article><span>0${index + 1}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section>${evidence}<section class="section boundary-table"><div><p class="section-index">${copy.boundaryLabel}</p><h2>${copy.boundaryHeading}</h2></div><dl>${copy.boundaries.map(([term, text]) => `<div><dt>${term}</dt><dd>${text}</dd></div>`).join("")}</dl></section><section class="section limitations"><div><p class="section-index">${copy.limitLabel}</p><h2>${copy.limitHeading}</h2></div><ul>${copy.limits.map((text) => `<li>${text}</li>`).join("")}</ul></section><section class="final-cta compact"><h2>${copy.cta}</h2><a class="button button-light" href="${publicPagePath("project", locale)}#book">${copy.book}</a></section></main>`,
  };
}

type TeamCopy = {
  title: string;
  summary: string;
  eyebrow: string;
  heading: string;
  lead: string;
  peopleLabel: string;
  peopleHeading: string;
  roles: [string, string];
  cta: string;
  book: string;
};

const teamCopy: Record<PublicLocale, TeamCopy> = {
  en: {
    title: "Team", summary: "Meet Oğuzcan Ünver and Fırat Kahya, the people planning and building Orkestr business systems.", eyebrow: "TEAM", heading: "Plan the work with the people building it.", lead: "The same people who shape the scope stay close to architecture, implementation, release, and operation.", peopleLabel: "CORE TEAM", peopleHeading: "Direct access. Clear ownership.", roles: ["Founder · Product & delivery", "Full-stack developer"], cta: "What should your business system do better?", book: "Book a project call",
  },
  de: {
    title: "Team", summary: "Lernen Sie Oğuzcan Ünver und Fırat Kahya kennen – die Menschen, die Orkestr-Unternehmenssysteme planen und entwickeln.", eyebrow: "TEAM", heading: "Planen Sie direkt mit den Menschen, die das System bauen.", lead: "Die Menschen, die den Umfang klären, bleiben auch bei Architektur, Umsetzung, Release und Betrieb nah am Projekt.", peopleLabel: "KERNTEAM", peopleHeading: "Direkter Austausch. Klare Verantwortung.", roles: ["Gründer · Produkt & Umsetzung", "Full-Stack-Entwickler"], cta: "Was soll in Ihrem Unternehmen besser funktionieren?", book: "Projektgespräch buchen",
  },
  tr: {
    title: "Ekip", summary: "Orkestr iş sistemlerini planlayan ve geliştiren Oğuzcan Ünver ile Fırat Kahya'yı tanıyın.", eyebrow: "EKİP", heading: "Projeyi, sistemi geliştiren insanlarla birlikte planlayın.", lead: "Kapsamı belirleyen ekip; mimari, geliştirme, yayın ve işletim boyunca projenin içinde kalır.", peopleLabel: "ÇEKİRDEK EKİP", peopleHeading: "Doğrudan iletişim. Net sorumluluk.", roles: ["Kurucu · Ürün ve proje teslimi", "Full Stack Geliştirici"], cta: "İşletmenizde neyin daha iyi çalışması gerekiyor?", book: "Proje görüşmesi planla",
  },
};

export function teamPage(locale: PublicLocale = "en"): PublicPage {
  const copy = teamCopy[locale];
  return {
    id: "team", locale, title: copy.title, summary: copy.summary, canonicalPath: publicPagePath("team", locale),
    body: `<main id="main-content"><section class="page-hero team-hero"><p class="section-index">${copy.eyebrow}</p><h1>${copy.heading}</h1><p class="lead">${copy.lead}</p></section><section class="section team-directory" aria-labelledby="team-directory-title"><div class="team-directory-heading"><p class="section-index">${copy.peopleLabel}</p><h2 id="team-directory-title">${copy.peopleHeading}</h2></div><div class="team-grid"><article class="team-member-card" id="oguzcan-unver"><img src="/assets/site/oguzcan-unver.png" width="262" height="262" alt="Oğuzcan Ünver" loading="eager" decoding="async"><div><h3>Oğuzcan Ünver</h3><p>${copy.roles[0]}</p></div></article><article class="team-member-card" id="firat-kahya"><img src="/assets/site/firat-kahya.jpeg" width="261" height="262" alt="Fırat Kahya" loading="eager" decoding="async"><div><h3>Fırat Kahya</h3><p>${copy.roles[1]}</p></div></article></div></section><section class="final-cta compact"><h2>${copy.cta}</h2><a class="button button-light" href="${publicPagePath("project", locale)}#book">${copy.book}</a></section></main>`,
  };
}
