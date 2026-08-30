import { publicPagePath, type PublicLocale, type PublicPage, type PublicPageId } from "./public-site-config.js";

type LocalizedSolution = {
  id: "websites-commerce" | "business-systems" | "opportunity-intelligence" | "web-data-monitoring" | "automation";
  verb: string; title: string; summary: string; heading: string; lead: string; request: string;
  outcomes: string[]; stages: Array<[string, string]>; proofTitle: string; proofText: string; boundaries: string[];
};

type SolutionUi = {
  indexTitle: string; indexSummary: string; indexHeading: string; indexLead: string; indexLabel: string;
  principleLabel: string; principleHeading: string; principleText: string; platformLink: string;
  explore: string; book: string; audit: string; outcomes: string; outcomeHeading: string;
  delivery: string; deliveryHeading: string; evidence: string; boundaries: string; boundariesHeading: string; cta: string;
};

const ui: Record<"de" | "tr", SolutionUi> = {
  de: {
    indexTitle: "Unternehmenssoftware & Automatisierung – Leistungen", indexSummary: "Orkestr entwickelt und betreibt Websites, Onlineshops, Unternehmenssoftware, Datenmonitoring und KI-gestützte Automatisierung.",
    indexHeading: "Fünf Wege von der Anforderung zum funktionierenden System.", indexLead: "Bringen Sie das gewünschte Ergebnis, den fehlerhaften Prozess oder die verpasste Chance mit. Orkestr bestimmt, ob klassische Software, Datenverarbeitung, Integration, Automatisierung, KI oder eine Kombination sinnvoll ist.", indexLabel: "ENTWICKELN · ERNEUERN · AUTOMATISIEREN · ERFASSEN · FINDEN",
    principleLabel: "EIN GRUNDSATZ", principleHeading: "Wir empfehlen keine KI, bevor wir die Arbeit verstanden haben.", principleText: "Für manche Anforderungen ist deterministische Software sicherer. Für andere ist KI hilfreich. Orkestr kombiniert die passenden Komponenten rund um das Geschäftsergebnis und macht die Betriebsgrenzen sichtbar.", platformLink: "Die Orkestr-Betriebsebene ansehen",
    explore: "Projektbeispiele ansehen", book: "Projektgespräch buchen", audit: "Workflow-Audit anfragen", outcomes: "MÖGLICHE ERGEBNISSE", outcomeHeading: "Ein klarer Projektumfang – kein beliebiges Technologiebündel.",
    delivery: "UMSETZUNGSWEG", deliveryHeading: "Vom Bedarf zum produktiven Betrieb.", evidence: "WAS ORKESTR EINBRINGT", boundaries: "GRENZEN", boundariesHeading: "Was in der Projektklärung festgelegt werden muss.", cta: "Sollen wir prüfen, ob dieses Projekt sinnvoll umsetzbar ist?",
  },
  tr: {
    indexTitle: "Özel Yazılım ve Otomasyon Hizmetleri", indexSummary: "Orkestr; web sitesi, e-ticaret, iş yazılımı, veri izleme ve yapay zekâ destekli otomasyon sistemleri geliştirir ve işletir.",
    indexHeading: "Bir iş ihtiyacını çalışan sisteme dönüştürmenin beş yolu.", indexLead: "Hedefi, aksayan süreci veya kaçırılan fırsatı anlatın. Çözümün standart yazılım, veri mühendisliği, entegrasyon, otomasyon, yapay zekâ ya da bunların dikkatli bir bileşimi olup olmadığını Orkestr belirlesin.", indexLabel: "GELİŞTİR · YENİLE · OTOMATİKLEŞTİR · TOPLA · BUL",
    principleLabel: "TEK İLKE", principleHeading: "İşi anlamadan yapay zekâ önermiyoruz.", principleText: "Bazı ihtiyaçlarda deterministik yazılım daha güvenlidir; bazılarında yapay zekâ değer üretir. Orkestr doğru bileşenleri iş sonucuna göre birleştirir ve işletim sınırlarını görünür tutar.", platformLink: "Orkestr işletim katmanını görün",
    explore: "Proje örneklerini inceleyin", book: "Proje görüşmesi planla", audit: "İş Akışı Analizi iste", outcomes: "OLASI ÇIKTILAR", outcomeHeading: "Rastgele bir teknoloji paketi değil, sınırları belli bir proje.",
    delivery: "UYGULAMA YOLU", deliveryHeading: "İhtiyaçtan canlı işletime.", evidence: "ORKESTR'İN KATKISI", boundaries: "SINIRLAR", boundariesHeading: "Proje keşfinde netleştirilmesi gerekenler.", cta: "Bu projenin gerçekçi olup olmadığını birlikte değerlendirelim mi?",
  },
};

const definitions: Record<"de" | "tr", LocalizedSolution[]> = {
  de: [
    {
      id: "websites-commerce", verb: "ENTWICKELN", title: "Websites, Onlineshops & Kundenportale",
      summary: "Orkestr konzipiert, entwickelt und betreibt individuelle Unternehmenswebsites, B2B-Portale, Onlineshops und fokussierte interne Anwendungen.",
      heading: "Individuelle Websites, Onlineshops und Portale für reale Geschäftsabläufe.", lead: "Beginnen Sie mit Zielgruppe, Transaktion, Dienstleistung oder interner Aufgabe – nicht mit einem vorgegebenen Technologie-Stack. Wir überführen die Anforderung in ein nutzbares, wartbares System mit klarem Betriebsmodell.",
      request: "Wir brauchen eine neue B2B-Website, über die freigeschaltete Kunden Produkte finden und bestellen können.", outcomes: ["Unternehmens- und Service-Websites", "B2B- und B2C-Onlineshops", "Kunden- und Partnerportale", "Fokussierte interne Anwendungen"],
      stages: [["Verstehen", "Nutzer, Abläufe, Inhalte, Transaktionen, Verantwortlichkeiten und Erfolgskriterien festlegen."], ["Entwerfen", "Oberfläche, Datenmodell, Integrationen, Administration und Liefergrenzen planen."], ["Entwickeln", "Das System mit bewährter Webtechnologie und nur der notwendigen Automatisierung umsetzen."], ["Betreiben", "Produktiv bereitstellen, überwachen, warten und nach dem vereinbarten Modell weiterentwickeln."]],
      proofTitle: "Software zuerst. KI nur dort, wo sie echten Nutzen bringt.", proofText: "Eine klassische Website oder Anwendung muss kein KI-Produkt sein. Orkestr verwendet Standardkomponenten für die Kernfunktion und ergänzt die Betriebsebene nur, wenn Agenten, Zeitpläne, Browserarbeit, Monitoring oder Freigaben sinnvoll sind.",
      boundaries: ["Hosting, Inhalte, Support, Analyse und Release-Verantwortung werden vor dem Start vereinbart.", "Zahlung, Identität, Steuern, Barrierefreiheit und regulatorische Anforderungen hängen vom Projekt und den gewählten Anbietern ab.", "Die Beispiele sind keine Festpreis-Pakete und keine Zusage universeller Integrationen."],
    },
    {
      id: "business-systems", verb: "ERNEUERN", title: "Altsysteme modernisieren & Unternehmenssoftware erneuern",
      summary: "Orkestr modernisiert oder ersetzt veraltete interne Software durch Prozessanalyse, schrittweise Migration, kontrollierte Integration, Tests und betreuten Betrieb.",
      heading: "Altsysteme modernisieren, ohne den laufenden Betrieb blind zu riskieren.", lead: "Ein Altsystem besteht nicht nur aus altem Code. Es enthält Daten, Ausnahmen, Gewohnheiten, Zuständigkeiten und Geschäftsregeln. Diese Realität wird erfasst, bevor wir eine Ablösung vorschlagen.",
      request: "Unser internes Bestellsystem ist fünfzehn Jahre alt und passt nicht mehr zu unseren Abläufen.", outcomes: ["Ablösung von Altsystemen", "Individuelle interne Anwendungen", "Prozess- und Oberflächendesign", "Schrittweise Datenmigration"],
      stages: [["Analysieren", "Nutzer, Prozesse, Daten, Schnittstellen, versteckte Regeln und Ausfallrisiken erfassen."], ["Entwerfen", "Festlegen, was erhalten, ersetzt, vereinfacht, integriert oder abgeschaltet wird."], ["Migrieren", "Das neue System mit repräsentativen Daten bauen, prüfen und schrittweise umstellen."], ["Betreiben", "Produktion überwachen, Nutzer unterstützen und verbessern, ohne den Rückweg zu verlieren."]],
      proofTitle: "Modernisierung ohne unkontrollierten Komplettumbau.", proofText: "Das Ziel ist ein sichereres Betriebssystem für das Unternehmen – nicht ein modischer Technologie-Stack. Manche Projekte ersetzen die Anwendung. Andere behalten einen stabilen Kern und ergänzen eine neue Oberfläche, Integration oder Automatisierung.",
      boundaries: ["Migrationsumfang und Datenqualität müssen vor einer verbindlichen Umsetzungszusage geprüft werden.", "Produktivzugriff, Backups, Aufbewahrung und Freigabe der Umstellung bleiben explizit.", "Die Analyse kann eine schrittweise Verbesserung statt einer vollständigen Ablösung empfehlen."],
    },
    {
      id: "opportunity-intelligence", verb: "FINDEN", title: "Ausschreibungs- & Chancenmonitoring",
      summary: "Relevante Ausschreibungen, Förderprogramme, RFPs, Lieferanten, Projekte und Marktchancen kontinuierlich finden, strukturieren, bewerten und an das Team weiterleiten.",
      heading: "Relevante Ausschreibungen und Geschäftschancen automatisch überwachen.", lead: "Orkestr kann ein betreutes System bauen, das freigegebene Quellen prüft, neue Chancen strukturiert, mit Ihren Kriterien abgleicht und relevante Ergebnisse zur Prüfung bereitstellt.",
      request: "Wir müssen täglich relevante öffentliche Ausschreibungen finden, bevor unser Team sie verpasst.", outcomes: ["Öffentliche Ausschreibungen", "Förderprogramme", "RFPs und Projektchancen", "Lieferanten und Partnerschaften"],
      stages: [["Erfassen", "Freigegebene Quellen über APIs, Feeds, Browserautomatisierung oder zulässige Extraktion prüfen."], ["Strukturieren", "Uneinheitliche Quellen mit Herkunftsnachweis in vergleichbare Datensätze überführen."], ["Abgleichen", "Feste Kriterien und bei Bedarf KI-gestützte Klassifikation oder Zusammenfassung anwenden."], ["Bereitstellen", "Benachrichtigungen, Prüflisten und Entscheidungsverfolgung einrichten und aus Feedback lernen."]],
      proofTitle: "Mehr als bloßes Monitoring.", proofText: "Ein Chancen-System kann Erfassung, Normalisierung, Abgleich, Bewertung, Zusammenfassung, Benachrichtigung und Prüfung verbinden. Jedes Ergebnis sollte Quelle und Auswahlgrund behalten.",
      boundaries: ["Quellen müssen öffentlich oder für die Bereitstellung ausdrücklich autorisiert sein.", "Abdeckung, Aktualität, Nutzungsbedingungen und Quellenstabilität werden in der Analyse geprüft.", "Automatischer Abgleich unterstützt Menschen; er garantiert weder Eignung noch Zuschlag."],
    },
    {
      id: "web-data-monitoring", verb: "ERFASSEN", title: "Web-Daten erfassen & überwachen",
      summary: "Informationen aus öffentlichen oder autorisierten Webquellen über APIs, Feeds, Browserautomatisierung oder zulässige Extraktion sammeln, strukturieren und überwachen.",
      heading: "Wiederkehrende Web-Recherche in ein verlässliches Datensystem verwandeln.", lead: "Wenn Mitarbeitende immer dieselben Seiten prüfen, Felder kopieren, Änderungen vergleichen oder Forschungsdateien zusammenstellen, prüfen wir ein kontrolliertes Erfassungs- und Monitoringsystem.",
      request: "Wir prüfen jeden Morgen Dutzende freigegebene Websites und übertragen Änderungen manuell in eine Tabelle.", outcomes: ["Strukturierte Web-Datenerfassung", "Änderungs- und Verfügbarkeitsmonitoring", "Benachrichtigungen und Exporte", "Recherche- und Anreicherungspipelines"],
      stages: [["Definieren", "Zulässige Quellen, Felder, Frequenz, Nachweise und Nutzung vereinbaren."], ["Erfassen", "Die stabilste autorisierte Methode verwenden: API, Feed, Browser oder Extraktion."], ["Prüfen", "Fehlende Felder, Layoutänderungen, Duplikate und unsichere Datensätze erkennen."], ["Betreiben", "Erfassungsqualität überwachen, Quellenadapter pflegen, Herkunft dokumentieren und Aktualisierungen liefern."]],
      proofTitle: "Scraping ist eine Technik – nicht das Produkt.", proofText: "Das Produkt sind verlässliche, strukturierte Informationen mit bekannter Herkunft und klarer Betriebsverantwortung. Die Erfassungsmethode kann sich ändern, ohne das Geschäftsergebnis zu verändern.",
      boundaries: ["Orkestr umgeht keine Zugriffskontrollen und erfasst keine Quellen ohne Berechtigung.", "Nutzungsbedingungen, Datenschutz, Urheberrecht, Robots-Hinweise, Limits und personenbezogene Daten werden quellenbezogen geprüft.", "Quellenänderungen und Schutzmechanismen können Machbarkeit und Wartungsaufwand beeinflussen."],
    },
    {
      id: "automation", verb: "AUTOMATISIEREN", title: "KI-Prozessautomatisierung & Workflows",
      summary: "Kontrollierte Geschäftsprozesse über E-Mail, Dokumente, interne Software, Browseranwendungen, Zeitpläne, Regeln, KI-Agenten und menschliche Freigaben entwickeln und betreiben.",
      heading: "Wiederkehrende Geschäftsprozesse mit KI und klaren Kontrollen automatisieren.", lead: "Orkestr bildet einen abgegrenzten Prozess ab, trennt feste Regeln von KI-gestützter Arbeit, verbindet nur die erforderlichen Systeme und hält wichtige Entscheidungen beim Menschen.",
      request: "Unsere Mitarbeitenden übertragen stundenlang Informationen zwischen E-Mail, Dokumenten und einer internen Browseranwendung.", outcomes: ["E-Mail- und Dokumentenprozesse", "ERP, CRM und interne Software", "Browserbasierte Anwendungen", "Freigaben und Ausnahmebehandlung"],
      stages: [["Analysieren", "Auslöser, Systeme, Übergaben, Entscheidungen, Ausnahmen und Ausgangslage erfassen."], ["Begrenzen", "Erlaubte Aktionen, feste Regeln, KI-Arbeit, Freigaben und Stopppunkte festlegen."], ["Pilotieren", "Einen kontrollierten Prozess umsetzen und normale sowie fehlerhafte Fälle testen."], ["Betreiben", "Abschlüsse, Eingriffe, Fehler, Verlauf und messbaren Nutzen überwachen."]],
      proofTitle: "Dauerhafte Arbeit statt einzelner Chat-Sitzungen.", proofText: "Die Orkestr-Betriebsebene koordiniert benannte Arbeitsstränge, Zeitpläne, Browserausführung, Dateien, Kommunikationskanäle, Freigaben, Unterbrechungen, Verlauf und Wiederherstellung rund um den definierten Prozess.",
      boundaries: ["Verbindungen und Aktionen werden je Bereitstellung konfiguriert.", "Folgenreiche oder irreversible Schritte benötigen eine passende Prüfrichtlinie.", "Orkestr ist weder ein Katalog von Ein-Klick-Automatisierungen noch ein System mit unbegrenztem autonomen Zugriff."],
    },
  ],
  tr: [
    {
      id: "websites-commerce", verb: "GELİŞTİR", title: "Web Sitesi, E-Ticaret ve Müşteri Portalları",
      summary: "Orkestr; iş hedefinize göre kurumsal web sitesi, B2B portalı, e-ticaret sitesi ve odaklı şirket içi uygulamalar tasarlar, geliştirir ve işletir.",
      heading: "İş akışınıza uygun web sitesi, e-ticaret ve müşteri portalları.", lead: "Önceden seçilmiş bir teknolojiyle değil; hedef kitle, işlem, hizmet veya şirket içi görevle başlayın. İhtiyacı kullanılabilir, bakımı yapılabilir bir sisteme ve net bir işletim planına dönüştürelim.",
      request: "Onaylı müşterilerin ürün bulup sipariş verebileceği yeni bir B2B web sitesine ihtiyacımız var.", outcomes: ["Kurumsal ve hizmet web siteleri", "B2B ve B2C e-ticaret", "Müşteri ve iş ortağı portalları", "Odaklı şirket içi uygulamalar"],
      stages: [["Keşfet", "Kullanıcıları, yolculukları, içeriği, işlemleri, sorumluluğu ve başarı ölçütünü tanımla."], ["Tasarla", "Arayüzü, veri modelini, entegrasyonları, yönetimi ve teslim sınırını planla."], ["Geliştir", "Standart web teknolojileriyle ve yalnızca gerekli otomasyonla sistemi uygula."], ["İşlet", "Canlıya al, izle, bakımını yap ve üzerinde anlaşılan modele göre geliştir."]],
      proofTitle: "Önce yazılım. Yapay zekâ yalnızca değer kattığı yerde.", proofText: "Klasik bir web sitesi veya uygulama yapay zekâ ürünü gibi davranmak zorunda değildir. Orkestr temel deneyimde standart bileşenleri kullanır; işletim katmanını yalnızca sürekli görevler, tarayıcı işlemleri, izleme veya onay gerektiğinde ekler.",
      boundaries: ["Barındırma, içerik sahipliği, destek, analiz ve yayın sorumluluğu canlıya geçmeden kararlaştırılır.", "Ödeme, kimlik, vergi, erişilebilirlik ve mevzuat gereksinimleri projeye ve sağlayıcılara bağlıdır.", "Örnekler sabit paket veya her sistemle entegrasyon vaadi değildir."],
    },
    {
      id: "business-systems", verb: "YENİLE", title: "Eski Sistem Modernizasyonu ve Özel Yazılım",
      summary: "Orkestr, eski şirket içi yazılımları süreç keşfi, aşamalı veri geçişi, kontrollü entegrasyon, test ve yönetilen işletimle modernleştirir veya değiştirir.",
      heading: "Eski sisteminizi, günlük işi riske atmadan modernleştirin.", lead: "Eski bir sistem yalnızca eski kod değildir; veri, istisnalar, alışkanlıklar, sorumluluklar ve iş kuralları içerir. Yenileme önermeden önce bu gerçekliği haritalarız.",
      request: "Şirket içi sipariş sistemimiz on beş yıllık ve işimizin bugünkü çalışma biçimine artık uymuyor.", outcomes: ["Eski sistemin yenilenmesi", "Özel şirket içi uygulamalar", "Süreç ve arayüz tasarımı", "Aşamalı veri geçişi"],
      stages: [["İncele", "Kullanıcıları, iş akışlarını, veriyi, entegrasyonları, gizli kuralları ve hata risklerini haritala."], ["Tasarla", "Neyin korunacağını, yenileneceğini, sadeleştirileceğini, bağlanacağını veya kapatılacağını seç."], ["Geçir", "Yeni sistemi temsili verilerle geliştir, doğrula ve aşamalı geçiş uygula."], ["İşlet", "Canlı sistemi izle, kullanıcıları destekle ve geri dönüş yolunu koruyarak geliştir."]],
      proofTitle: "Körlemesine yeniden yazmadan modernizasyon.", proofText: "Amaç moda bir teknoloji seçmek değil, işletme için daha güvenli bir çalışma sistemi kurmaktır. Bazı projelerde uygulama tamamen yenilenir; bazılarında sağlam çekirdek korunur ve yeni arayüz, entegrasyon veya otomasyon eklenir.",
      boundaries: ["Sabit bir uygulama sözü verilmeden önce veri kalitesi ve geçiş kapsamı incelenmelidir.", "Canlı erişim, yedekleme, saklama ve geçiş onayı açık biçimde tanımlanır.", "Keşif çalışması tam yenileme yerine aşamalı iyileştirme önerebilir."],
    },
    {
      id: "opportunity-intelligence", verb: "BUL", title: "İhale ve İş Fırsatı Takibi",
      summary: "İlgili ihaleleri, destekleri, teklif çağrılarını, tedarikçileri, projeleri ve pazar fırsatlarını sürekli bulup yapılandıran, eşleştiren ve ekibe sunan sistemler.",
      heading: "İlgili ihaleleri ve iş fırsatlarını sürekli takip edin.", lead: "Orkestr; onaylı kaynakları kontrol eden, yeni fırsatları yapılandıran, ölçütlerinizle eşleştiren ve yararlı sonuçları ekibin incelemesine sunan yönetilen bir sistem kurabilir.",
      request: "Ekibimiz kaçırmadan önce her gün ilgili kamu ihalelerini bulmamız gerekiyor.", outcomes: ["Kamu ihaleleri", "Hibe ve destek çağrıları", "Teklif ve proje fırsatları", "Tedarikçi ve iş ortaklıkları"],
      stages: [["Topla", "Onaylı kaynakları API, akış, tarayıcı otomasyonu veya izinli veri çıkarımıyla kontrol et."], ["Yapılandır", "Farklı kaynakları köken bilgisi korunmuş karşılaştırılabilir kayıtlara dönüştür."], ["Eşleştir", "Sabit ölçütleri ve gerektiğinde yapay zekâ destekli sınıflandırma veya özeti uygula."], ["Sun", "Bildirim, inceleme kuyruğu ve karar takibi kur; geri bildirimden eşleşmeyi geliştir."]],
      proofTitle: "Yalnızca takipten fazlası.", proofText: "Fırsat sistemi; toplama, normalleştirme, eşleştirme, puanlama, özetleme, bildirim ve incelemeyi birleştirebilir. Her sonuç kaynağını ve neden gösterildiğini korumalıdır.",
      boundaries: ["Kaynaklar herkese açık veya proje için açıkça yetkilendirilmiş olmalıdır.", "Kapsama, güncelleme sıklığı, kullanım koşulları ve kaynak kararlılığı keşif sırasında değerlendirilir.", "Otomatik eşleştirme insan incelemesini destekler; uygunluk veya başarı garantisi vermez."],
    },
    {
      id: "web-data-monitoring", verb: "TOPLA", title: "Web Verisi Toplama ve İzleme",
      summary: "Herkese açık veya yetkili web kaynaklarından API, akış, tarayıcı otomasyonu ya da izinli veri çıkarımıyla bilgi toplayan, yapılandıran ve izleyen sistemler.",
      heading: "Tekrarlanan web araştırmasını sürdürülebilir bir veri sistemine dönüştürün.", lead: "Çalışanlar aynı siteleri tekrar tekrar kontrol ediyor, aynı alanları kopyalıyor veya değişiklikleri elle karşılaştırıyorsa kontrollü bir toplama ve izleme sistemi değerlendirebiliriz.",
      request: "Her sabah onlarca onaylı web sitesini kontrol ediyor ve değişiklikleri elle bir tabloya aktarıyoruz.", outcomes: ["Yapılandırılmış web verisi", "Değişiklik ve erişilebilirlik takibi", "Bildirimler ve dışa aktarımlar", "Araştırma ve veri zenginleştirme hatları"],
      stages: [["Tanımla", "İzinli kaynakları, alanları, sıklığı, kanıtı ve kullanım amacını kararlaştır."], ["Topla", "En kararlı yetkili yöntemi kullan: API, veri akışı, tarayıcı veya çıkarım."], ["Doğrula", "Eksik alanları, sayfa değişikliklerini, kopyaları ve belirsiz kayıtları tespit et."], ["İşlet", "Toplama sağlığını izle, kaynak bağlayıcılarını koru, kökeni kaydet ve güncellemeleri sun."]],
      proofTitle: "Scraping bir tekniktir; ürün değildir.", proofText: "Ürün, kaynağı bilinen ve işletim sorumlusu belli güvenilir yapılandırılmış bilgidir. Toplama yöntemi zamanla değişebilir; iş sonucu aynı kalır.",
      boundaries: ["Orkestr erişim kontrollerini aşmaz ve müşterinin yetkili olmadığı kaynaklardan veri toplamaz.", "Kullanım koşulları, gizlilik, telif, robots yönlendirmeleri, hız sınırları ve kişisel veri riski kaynak bazında incelenir.", "Kaynak değişiklikleri ve otomasyon önlemleri uygulanabilirliği ve bakım maliyetini etkileyebilir."],
    },
    {
      id: "automation", verb: "OTOMATİKLEŞTİR", title: "Yapay Zekâ İş Akışı Otomasyonu",
      summary: "E-posta, belge, iş yazılımı, tarayıcı uygulaması, zamanlama, kural, yapay zekâ ajanı ve insan onayı arasında kontrollü süreçler geliştirip işletin.",
      heading: "Tekrarlanan iş süreçlerini yapay zekâ ve açık kontrollerle otomatikleştirin.", lead: "Orkestr sınırları belli bir süreci haritalar, kesin kuralları yapay zekâ çalışmalarından ayırır, yalnızca gerekli sistemleri bağlar ve önemli kararlarda insan kontrolünü korur.",
      request: "Çalışanlarımız e-posta, belge ve şirket içi tarayıcı uygulaması arasında saatlerce bilgi taşıyor.", outcomes: ["E-posta ve belge süreçleri", "ERP, CRM ve iç sistemler", "Yalnızca tarayıcıdan çalışan uygulamalar", "Onaylar ve istisna yönetimi"],
      stages: [["Analiz et", "Tetikleyicileri, sistemleri, aktarımları, kararları, istisnaları ve mevcut ölçümü haritala."], ["Sınırla", "İzinli işlemleri, kesin kuralları, yapay zekâ görevlerini, onayları ve durma koşullarını tanımla."], ["Pilotla", "Kontrollü bir süreci uygula; normal, istisna ve hata durumlarını test et."], ["İşlet", "Tamamlanma, insan müdahalesi, hata, geçmiş ve ölçülebilir operasyon değerini izle."]],
      proofTitle: "Tek seferlik sohbet değil, kalıcı iş.", proofText: "Orkestr işletim katmanı; tanımlı süreç etrafında görev dizilerini, zamanlamayı, tarayıcı işlemlerini, dosyaları, iletişimi, onayları, kesintileri, geçmişi ve hata sonrası devamı koordine eder.",
      boundaries: ["Bağlantılar ve işlemler her kurulum için ayrıca yapılandırılır.", "Yüksek etkili veya geri alınamaz adımlar uygun insan incelemesi gerektirir.", "Orkestr tek tıklamalı otomasyon kataloğu veya şirkete sınırsız erişen otonom bir sistem değildir."],
    },
  ],
};

function solutionCta(locale: "de" | "tr", heading: string) {
  return `<section class="final-cta compact"><div><p class="section-index">PROJECT DISCOVERY</p><h2>${heading}</h2></div><a class="button button-light" href="${publicPagePath("project", locale)}#book" data-event="solution_describe_project">${ui[locale].book}</a></section>`;
}

export function localizedWhatWeBuildPage(locale: "de" | "tr"): PublicPage {
  const copy = ui[locale];
  const cards = definitions[locale].map((item) => `<article class="offer-card"><span>${item.verb}</span><h3>${item.title}</h3><blockquote>“${item.request}”</blockquote><p>${item.summary}</p><a href="${publicPagePath(item.id, locale)}">${copy.explore} <span aria-hidden="true">→</span></a></article>`).join("");
  return {
    id: "use-cases", locale, title: copy.indexTitle, summary: copy.indexSummary, canonicalPath: publicPagePath("use-cases", locale),
    body: `<main id="main-content"><section class="page-hero"><p class="section-index">${copy.indexLabel}</p><h1>${copy.indexHeading}</h1><p class="lead">${copy.indexLead}</p></section><section class="section solution-index"><div class="section-heading"><h2>${copy.outcomeHeading}</h2></div><div class="offer-grid">${cards}</div></section><section class="section solution-principle"><div><p class="section-index">${copy.principleLabel}</p><h2>${copy.principleHeading}</h2></div><div><p class="section-lead">${copy.principleText}</p><a class="text-link" href="${publicPagePath("home", locale)}#platform">${copy.platformLink} <span aria-hidden="true">→</span></a></div></section>${solutionCta(locale, copy.cta)}</main>`,
  };
}

export function localizedSolutionPage(pageId: PublicPageId, locale: "de" | "tr"): PublicPage {
  const solution = definitions[locale].find((item) => item.id === pageId) || definitions[locale][0];
  const copy = ui[locale];
  const audit = solution.id === "automation" ? `<a class="button button-ghost" href="/workflow" data-event="automation_audit_click">${copy.audit}</a>` : "";
  return {
    id: solution.id, locale, title: solution.title, summary: solution.summary, canonicalPath: publicPagePath(solution.id, locale),
    body: `<main id="main-content"><section class="page-hero solution-hero"><p class="section-index">${solution.verb} · BUSINESS SYSTEMS &amp; AUTOMATION</p><h1>${solution.heading}</h1><p class="lead">${solution.lead}</p><blockquote>“${solution.request}”</blockquote><div class="actions"><a class="button" href="${publicPagePath("project", locale)}#book" data-event="solution_describe_project">${copy.book}</a>${audit}</div></section>
      <section class="section solution-outcomes"><div><p class="section-index">${copy.outcomes}</p><h2>${copy.outcomeHeading}</h2></div><ul>${solution.outcomes.map((item) => `<li>${item}</li>`).join("")}</ul></section>
      <section class="section solution-delivery"><div><p class="section-index">${copy.delivery}</p><h2>${copy.deliveryHeading}</h2></div><ol>${solution.stages.map(([title, text], index) => `<li><span>0${index + 1}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join("")}</ol></section>
      <section class="section solution-proof"><div><p class="section-index">${copy.evidence}</p><h2>${solution.proofTitle}</h2></div><p class="section-lead">${solution.proofText}</p></section>
      <section class="section limitations"><div><p class="section-index">${copy.boundaries}</p><h2>${copy.boundariesHeading}</h2></div><ul>${solution.boundaries.map((item) => `<li>${item}</li>`).join("")}</ul></section>${solutionCta(locale, copy.cta)}</main>`,
  };
}
