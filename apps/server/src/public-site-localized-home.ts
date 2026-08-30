import { publicPagePath, type PublicLocale, type PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence } from "./public-site-components.js";

type LocalizedHomeCopy = {
  title: string; summary: string; eyebrow: string; heading: string; lead: string; detail: string;
  book: string; see: string; trust: string[]; brief: { label: string; title: string; items: Array<[string, string]>; note: string };
  services: { label: string; heading: string; intro: string; items: Array<{ title: string; copy: string; examples: string; id: "websites-commerce" | "business-systems" | "automation" }>; link: string };
  examples: { label: string; heading: string; items: Array<[string, string, string]>; link: string };
  process: { label: string; heading: string; intro: string; items: Array<[string, string]> };
  proof: { label: string; heading: string; paragraphs: string[]; points: string[]; link: string };
  final: { label: string; heading: string; text: string; book: string; write: string };
};

const localizedHomeCopy: Record<"de" | "tr", LocalizedHomeCopy> = {
  de: {
    title: "Individuelle Unternehmenssoftware & Automatisierung",
    summary: "Orkestr konzipiert, entwickelt, modernisiert und betreibt Unternehmenssoftware, Websites, Datensysteme und Automatisierung für konkrete Geschäftsanforderungen.",
    eyebrow: "UNTERNEHMENSSYSTEME · GEBAUT & BETRIEBEN",
    heading: "Braucht Ihr Unternehmen ein besseres System?",
    lead: "Orkestr konzipiert, entwickelt, modernisiert und betreibt die Software hinter realen Geschäftsprozessen.",
    detail: "Von Websites und internen Anwendungen bis zu Datensystemen und Automatisierung. Ein kurzes Gespräch genügt für den Anfang – ein technisches Lastenheft ist nicht erforderlich.",
    book: "20-minütiges Projektgespräch buchen", see: "Leistungen ansehen",
    trust: ["Mit dem Problem beginnen", "Klares Angebot vor der Umsetzung", "Betreuung nach dem Start"],
    brief: { label: "PROJEKTBEISPIEL", title: "Internes Bestellsystem", items: [["Problem", "Ein altes System unterstützt die heutige Auftragsbearbeitung nicht mehr."], ["Umsetzung", "Eine schrittweise Ablösung, die Nutzer, Daten und Freigaben berücksichtigt."], ["Betrieb", "Bereitstellen, überwachen, unterstützen und gezielt weiterentwickeln."]], note: "Ergebnis zuerst. Technologie danach." },
    services: {
      label: "WAS WIR BAUEN", heading: "Drei Wege zu einem besseren System.", intro: "Beschreiben Sie, was sich ändern soll. Wir bestimmen, welche Art von System dafür sinnvoll ist.", link: "Mehr erfahren",
      items: [
        { title: "Neue Systeme entwickeln", copy: "Eine Website, einen Onlineshop, ein Portal, ein internes Tool oder eine Kundenanwendung entwickeln – passend zum tatsächlichen Geschäftsablauf.", examples: "Websites · E-Commerce · Portale · Anwendungen", id: "websites-commerce" },
        { title: "Bestehende Systeme modernisieren", copy: "Eine veraltete Anwendung ablösen, einen fehleranfälligen Prozess neu gestalten oder einen sicheren Weg aus unpassender Altsoftware schaffen.", examples: "Altsysteme · Interne Software · Migration", id: "business-systems" },
        { title: "Arbeit und Daten automatisieren", copy: "Informationen erfassen und überwachen, Software verbinden und wiederkehrende Handarbeit in einen kontrollierten Prozess überführen.", examples: "Datenmonitoring · Integrationen · KI-Workflows", id: "automation" },
      ],
    },
    examples: {
      label: "MIT EINEM REALEN PROBLEM BEGINNEN", heading: "Sie brauchen noch kein technisches Konzept.", link: "Weitere Projektbeispiele",
      items: [["ENTWICKELN", "„Wir brauchen eine neue B2B-Website, über die Kunden bestellen können.“", "Website, Kundenkonto, Bestellprozess, Administration und Inbetriebnahme."], ["MODERNISIEREN", "„Unser internes System ist alt, instabil und passt nicht mehr zum Unternehmen.“", "Analyse, Ablösungskonzept, Migrationsplan und kontrollierte Umstellung."], ["AUTOMATISIEREN", "„Unser Team durchsucht regelmäßig Websites und überträgt Ergebnisse von Hand.“", "Autorisierte Erfassung, strukturierte Daten, Prüfung, Benachrichtigungen und Betrieb."]],
    },
    process: { label: "SO ARBEITEN WIR", heading: "Vom Gespräch zum produktiven System.", intro: "Jedes Projekt folgt einem sichtbaren Entscheidungsweg. Vor der Umsetzung wissen Sie, was gebaut wird.", items: [["Sprechen", "Sie erklären das gewünschte Ergebnis, das heutige Problem und die betroffenen Nutzer."], ["Definieren", "Wir klären Umfang, Architektur, Risiken, Verantwortlichkeiten und Betriebsmodell."], ["Bauen", "Wir implementieren, testen und stellen das vereinbarte System bereit."], ["Betreiben", "Wir überwachen, warten, unterstützen und verbessern das System nach dem Start."]] },
    proof: { label: "AUF ORKESTR AUFGEBAUT", heading: "Für einen verlässlichen Betrieb nach dem Start.", paragraphs: ["Wenn ein System geplante Abläufe, Browserausführung, dauerhafte Aufgaben, menschliche Entscheidungen oder Wiederherstellung benötigt, hält die Orkestr-Betriebsebene diese Arbeit sichtbar und kontrollierbar.", "Jedes Projekt nutzt den kleinsten Funktionsumfang, der die Anforderung zuverlässig erfüllt."], points: ["APIs, wenn verfügbar", "Kontrollierte Browserausführung, wenn sinnvoll", "Explizite Zugriffe und menschliche Prüfung, wo erforderlich"], link: "So wird der Zugriff kontrolliert" },
    final: { label: "MIT 20 MINUTEN BEGINNEN", heading: "Erzählen Sie uns, was besser funktionieren soll.", text: "In einem kurzen Gespräch klären wir den Bedarf und bestimmen einen sinnvollen nächsten Schritt. Ein technisches Lastenheft oder eine Plattformmigration ist dafür nicht erforderlich.", book: "Projektgespräch buchen", write: "Oder in 60 Sekunden beschreiben" },
  },
  tr: {
    title: "Özel İş Yazılımı ve Otomasyon",
    summary: "Orkestr, somut iş ihtiyaçları için kurumsal yazılım, web sitesi, veri sistemi ve otomasyon tasarlar, geliştirir, modernleştirir ve işletir.",
    eyebrow: "İŞ SİSTEMLERİ · GELİŞTİRME & İŞLETİM",
    heading: "İşletmeniz için daha iyi bir sisteme mi ihtiyacınız var?",
    lead: "Orkestr, gerçek iş süreçlerinin arkasındaki yazılımı tasarlar, geliştirir, modernleştirir ve işletir.",
    detail: "Web sitelerinden şirket içi araçlara, veri sistemlerinden otomasyona kadar. Başlamak için kısa bir görüşme yeterlidir; teknik şartname hazırlamanız gerekmez.",
    book: "20 dakikalık proje görüşmesi planla", see: "Neler yaptığımızı görün",
    trust: ["Sorunla başlayın", "Geliştirmeden önce net teklif", "Yayından sonra bakım ve işletim"],
    brief: { label: "PROJE ÖRNEĞİ", title: "Şirket içi sipariş sistemi", items: [["Sorun", "Eski araç, siparişlerin bugün nasıl yönetildiğini artık desteklemiyor."], ["Geliştirme", "Kullanıcıları, veriyi ve onayları dikkate alan aşamalı bir yenileme."], ["İşletim", "Yayına alma, izleme, destek ve sürekli iyileştirme."]], note: "Önce sonuç. Sonra teknoloji." },
    services: {
      label: "NELER GELİŞTİRİYORUZ", heading: "İşletmenize üç şekilde yardımcı olabiliriz.", intro: "Neyin değişmesi gerektiğini anlatın. Nasıl bir sistem kurulması gerektiğini biz belirleyelim.", link: "Detayları inceleyin",
      items: [
        { title: "Yeni sistemler geliştirme", copy: "Orkestr, işletmenin gerçek çalışma biçimine göre web sitesi, e-ticaret, portal, şirket içi araç veya müşteri uygulaması geliştirir.", examples: "Web siteleri · E-ticaret · Portallar · Uygulamalar", id: "websites-commerce" },
        { title: "Mevcut sistemleri modernleştirme", copy: "Eski bir uygulamayı yeniler, aksayan bir süreci yeniden tasarlar veya ihtiyacı karşılamayan yazılımdan kontrollü bir geçiş planlar.", examples: "Eski sistemler · İç yazılımlar · Veri geçişi", id: "business-systems" },
        { title: "İş ve veri otomasyonu", copy: "Bilgiyi toplar ve izler, yazılımları birbirine bağlar, tekrarlanan manuel işleri kontrollü bir iş sürecine dönüştürür.", examples: "Veri izleme · Entegrasyon · Yapay zekâ iş akışları", id: "automation" },
      ],
    },
    examples: {
      label: "GERÇEK BİR SORUNLA BAŞLAYIN", heading: "Teknik şartnameyle gelmeniz gerekmez.", link: "Daha fazla proje örneği",
      items: [["GELİŞTİR", "“Müşterilerin sipariş verebileceği yeni bir B2B web sitesine ihtiyacımız var.”", "Web sitesi, müşteri hesabı, sipariş süreci, yönetim ve yayın."], ["MODERNLEŞTİR", "“Şirket içi sistemimiz eski, kırılgan ve artık işimize uymuyor.”", "İnceleme, yenileme tasarımı, geçiş planı ve kontrollü devreye alma."], ["OTOMATİKLEŞTİR", "“Ekibimiz sürekli aynı web sitelerini kontrol ediyor ve sonuçları elle aktarıyor.”", "Yetkili veri toplama, yapılandırma, inceleme, bildirim ve işletim."]],
    },
    process: { label: "NASIL ÇALIŞIYORUZ", heading: "Görüşmeden çalışan sisteme.", intro: "Her proje görünür bir karar süreciyle ilerler. Geliştirme başlamadan önce ne yapılacağını bilirsiniz.", items: [["Görüşme", "Hedefi, mevcut sorunu ve kimleri etkilediğini anlatırsınız."], ["Tanımlama", "Kullanıcıları, kapsamı, mimariyi, riskleri ve işletim modelini birlikte netleştiririz."], ["Geliştirme", "Kararlaştırılan sistemi geliştirir, test eder ve devreye alırız."], ["İşletim", "Yayından sonra sistemi izler, bakımını yapar, destekler ve geliştiririz."]] },
    proof: { label: "ORKESTR ÜZERİNDE ÇALIŞIR", heading: "Yayından sonra da güvenilir biçimde çalışır.", paragraphs: ["Bir sistem zamanlanmış işler, tarayıcı işlemleri, kalıcı görevler, insan kararları veya hata sonrası devam kabiliyeti gerektiriyorsa Orkestr işletim katmanı bu çalışmayı görünür ve kontrollü tutar.", "Her proje, ihtiyacı güvenilir biçimde karşılayan en sade bileşenlerle kurulur."], points: ["Mevcut olduğunda API'ler", "Uygun olduğunda kontrollü tarayıcı işlemleri", "Gerektiğinde açık erişim sınırları ve insan incelemesi"], link: "Erişimin nasıl kontrol edildiğini görün" },
    final: { label: "20 DAKİKAYLA BAŞLAYIN", heading: "Neyin daha iyi çalışması gerektiğini anlatın.", text: "Kısa bir görüşmeyle ihtiyacı netleştirir ve doğru sonraki adımı belirleriz. Bunun için teknik şartname veya platform geçişi gerekmez.", book: "Proje görüşmesi planla", write: "Ya da 60 saniyede yazın" },
  },
};

export function localizedCommercialHomePage(locale: "de" | "tr"): PublicPage {
  const copy = localizedHomeCopy[locale];
  const project = publicPagePath("project", locale);
  const home = publicPagePath("home", locale);
  const security = publicPagePath("security", locale);
  const services = copy.services.items.map((item, index) => `<article class="v4-service-card"><span>0${index + 1}</span><h3>${item.title}</h3><p>${item.copy}</p><small>${item.examples}</small><a href="${publicPagePath(item.id, locale)}" data-event="service_group_click">${copy.services.link} <span aria-hidden="true">→</span></a></article>`).join("");
  return {
    id: "home", locale, title: copy.title, summary: copy.summary, canonicalPath: home,
    body: `<main id="main-content" class="v4-home">
      <section class="v4-section v4-hero" aria-labelledby="home-title"><div class="v4-hero-copy"><p class="eyebrow">${copy.eyebrow}</p><h1 id="home-title">${copy.heading}</h1><p class="lead">${copy.lead}</p><p class="hero-detail">${copy.detail}</p><div class="actions"><a class="button" href="${project}#book" data-event="book_project_hero">${copy.book}</a><a class="button button-ghost" href="#services" data-event="see_services">${copy.see}</a></div><ul class="v4-trust">${copy.trust.map((item) => `<li>${item}</li>`).join("")}</ul></div>
      <article class="v4-brief-card"><div class="v4-brief-head"><span>${copy.brief.label}</span><strong>${copy.brief.title}</strong></div><dl>${copy.brief.items.map(([term, text]) => `<div><dt>${term}</dt><dd>${text}</dd></div>`).join("")}</dl><p><span aria-hidden="true">●</span>${copy.brief.note}</p></article></section>
      <section class="v4-section v4-services" id="services"><div class="v4-section-head"><p class="section-index">${copy.services.label}</p><h2>${copy.services.heading}</h2><p>${copy.services.intro}</p></div><div class="v4-service-grid">${services}</div></section>
      <section class="v4-section v4-examples" id="examples"><div class="v4-section-head"><p class="section-index">${copy.examples.label}</p><h2>${copy.examples.heading}</h2></div><div class="v4-example-list">${copy.examples.items.map(([label, quote, text]) => `<article><span>${label}</span><blockquote>${quote}</blockquote><p>${text}</p></article>`).join("")}</div><a class="text-link" href="${publicPagePath("use-cases", locale)}">${copy.examples.link} <span aria-hidden="true">→</span></a></section>
      <section class="v4-section v4-process" id="how-we-work"><div class="v4-section-head"><p class="section-index">${copy.process.label}</p><h2>${copy.process.heading}</h2><p>${copy.process.intro}</p></div><ol class="v4-process-list">${copy.process.items.map(([title, text], index) => `<li><span>0${index + 1}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join("")}</ol></section>
      <section class="v4-section v4-proof" id="platform"><div class="v4-proof-copy"><p class="section-index">${copy.proof.label}</p><h2>${copy.proof.heading}</h2>${copy.proof.paragraphs.map((text) => `<p>${text}</p>`).join("")}<ul>${copy.proof.points.map((text) => `<li>${text}</li>`).join("")}</ul><a class="text-link inverse-link" href="${security}">${copy.proof.link} <span aria-hidden="true">→</span></a></div>${renderConsoleEvidence(locale)}</section>
      <section class="v4-section v4-final"><p class="section-index">${copy.final.label}</p><h2>${copy.final.heading}</h2><p>${copy.final.text}</p><div class="actions"><a class="button button-light" href="${project}#book" data-event="book_project_final">${copy.final.book}</a><a class="text-link inverse-link" href="${project}#quick-project-form" data-event="quick_project_final">${copy.final.write} <span aria-hidden="true">→</span></a></div></section>
    </main>`,
  };
}
