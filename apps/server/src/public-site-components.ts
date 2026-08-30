export function renderCoordinationDiagram() {
  return `<figure class="coordination" aria-labelledby="coordination-title">
    <figcaption id="coordination-title"><span>LIVE PROCESS MAP</span> One request moving across the existing stack</figcaption>
    <ol class="operation-trace">
      <li><span class="trace-icon">IN</span><div><small>TRIGGER</small><strong>Incoming customer request</strong><p>A request arrives from an approved source.</p></div></li>
      <li><span class="trace-icon">@</span><div><small>EMAIL</small><strong>Message and attachments read</strong><p>The workflow identifies the request and required records.</p></div></li>
      <li><span class="trace-icon">E</span><div><small>ERP</small><strong>Order and account checked</strong><p>Orkestr retrieves the operational record.</p></div></li>
      <li><span class="trace-icon">C</span><div><small>CRM</small><strong>Customer history gathered</strong><p>Relevant context is added to the case.</p></div></li>
      <li class="trace-orkestr"><span class="trace-icon">O</span><div><small>ORKESTR</small><strong>Information reconciled</strong><p>Rules, agent work, and exception handling run in one stateful process.</p></div></li>
      <li class="trace-approval"><span class="trace-icon">✓</span><div><small>MANAGER APPROVAL</small><strong>Decision requested</strong><p>The workflow pauses because the case exceeds its approved boundary.</p></div></li>
      <li><span class="trace-icon">OUT</span><div><small>COMPLETION</small><strong>ERP updated and reply sent</strong><p>The decision and every subsequent action remain in history.</p></div></li>
    </ol>
    <p class="diagram-note">Illustrative workflow using public-safe records. The systems, permissions, and approval points are configured per deployment.</p>
  </figure>`;
}

export function renderProjectDeliveryDiagram() {
  return `<figure class="coordination requirement-delivery" aria-labelledby="requirement-delivery-title">
    <figcaption id="requirement-delivery-title"><span>FROM REQUIREMENT TO OPERATION</span> The same delivery system underneath different outcomes</figcaption>
    <div class="requirement-quote"><small>YOUR REQUIREMENT</small><blockquote id="requirement-example">“Our internal ordering system needs replacing.”</blockquote></div>
    <div class="project-scenario-tabs" aria-label="Example project requirements">
      <button type="button" class="active" aria-pressed="true" data-requirement="Our internal ordering system needs replacing.">Replace a system</button>
      <button type="button" aria-pressed="false" data-requirement="We need a new B2B website with customer ordering.">Build commerce</button>
      <button type="button" aria-pressed="false" data-requirement="Our staff spend hours moving information between email and internal software.">Automate work</button>
      <button type="button" aria-pressed="false" data-requirement="We need to automatically find relevant public tenders every day.">Find opportunities</button>
    </div>
    <ol class="operation-trace delivery-trace">
      <li><span class="trace-icon">01</span><div><small>DISCOVER</small><strong>Outcome, users, constraints, and success</strong><p>We understand what the business needs before choosing technology.</p></div></li>
      <li><span class="trace-icon">02</span><div><small>DESIGN</small><strong>Architecture, interfaces, data, and operation</strong><p>The proposed system has an explicit scope and responsibility model.</p></div></li>
      <li class="trace-orkestr"><span class="trace-icon">03</span><div><small>BUILD</small><strong>Application, data, integrations, and automation</strong><p>Standard software and the Orkestr layer are used where each is appropriate.</p></div></li>
      <li><span class="trace-icon">04</span><div><small>TEST</small><strong>Representative cases and failure paths</strong><p>Normal behavior, edge cases, permissions, and recovery are exercised.</p></div></li>
      <li><span class="trace-icon">05</span><div><small>DEPLOY</small><strong>A controlled production environment</strong><p>The release, ownership, monitoring, and rollback path are defined.</p></div></li>
      <li class="trace-approval"><span class="trace-icon">06</span><div><small>OPERATE</small><strong>Monitor, maintain, and improve</strong><p>We keep the agreed system working after the launch or demo.</p></div></li>
    </ol>
    <p class="diagram-note">Illustrative project requirements. Scope, feasibility, delivery model, and Orkestr platform use are determined during Project Discovery.</p>
    <script>(() => { const output = document.getElementById("requirement-example"); const buttons = document.querySelectorAll("[data-requirement]"); buttons.forEach((button) => button.addEventListener("click", () => { buttons.forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-pressed", "false"); }); button.classList.add("active"); button.setAttribute("aria-pressed", "true"); if (output) output.textContent = "“" + button.dataset.requirement + "”"; })); })();</script>
  </figure>`;
}

type ConsoleLocale = "en" | "de" | "tr";

const consoleCopy: Record<ConsoleLocale, { title: string; note: string; queue: string; states: string[]; heading: string; review: string; steps: Array<[string, string, string]>; actions: string[]; context: string; systems: Array<[string, string]>; boundary: string; limits: Array<[string, string]>; walkthrough: string[] }> = {
  en: {
    title: "Internal Ordering Renewal · Migration Run #042", note: "Public-safe illustrative data. Available systems, connections, and controls depend on the deployment.", queue: "MIGRATION RUNS · 4", states: ["Completed", "Reviewing exceptions", "Staged", "Awaiting approval"], heading: "Twelve legacy records need an owner decision", review: "Human review",
    steps: [["08:00", "Legacy snapshot read", "The approved export was loaded without changing the existing system."], ["08:05", "Migration rules applied", "Fields, relationships, and known business rules were mapped into the new model."], ["08:11", "Validation completed", "2,486 records passed the configured structural and reconciliation checks."], ["08:12", "Exception queue prepared", "An owner reviews twelve records whose legacy ownership is missing or ambiguous."], ["Next", "Record decisions", "Every approved correction remains attached to its source record and rule."], ["Next", "Release migration batch", "The validated batch advances only after the agreed cutover approval."]],
    actions: ["Approve mapping", "Review record", "Demo controls are inactive."], context: "SYSTEM COMPONENTS", systems: [["Legacy database", "Read only"], ["Migration service", "Staged"], ["New application", "Ready"], ["Rollback", "Available"]], boundary: "BOUNDARY", limits: [["Owner", "Operations lead"], ["Legacy access", "Read only"], ["Changes", "Staged"], ["Cutover", "Human"]], walkthrough: ["Snapshot read", "Rules applied", "Validation passed", "Human review", "Record decisions", "Release batch"],
  },
  de: {
    title: "Erneuerung internes Bestellsystem · Migrationslauf #042", note: "Illustrative, öffentlich geeignete Beispieldaten. Verfügbare Systeme, Verbindungen und Kontrollen unterscheiden sich je Bereitstellung.", queue: "MIGRATIONSLÄUFE · 4", states: ["Abgeschlossen", "Ausnahmen werden geprüft", "Vorbereitet", "Freigabe ausstehend"], heading: "Zwölf Altdatensätze benötigen eine Entscheidung", review: "Menschliche Prüfung",
    steps: [["08:00", "Altdaten-Snapshot gelesen", "Der freigegebene Export wurde geladen, ohne das bestehende System zu verändern."], ["08:05", "Migrationsregeln angewendet", "Felder, Beziehungen und bekannte Geschäftsregeln wurden in das neue Modell übertragen."], ["08:11", "Validierung abgeschlossen", "2.486 Datensätze haben die konfigurierten Struktur- und Abgleichprüfungen bestanden."], ["08:12", "Ausnahmeliste vorbereitet", "Eine verantwortliche Person prüft zwölf Datensätze mit fehlender oder unklarer Zuordnung."], ["Danach", "Entscheidungen erfassen", "Jede freigegebene Korrektur bleibt mit Quelldatensatz und Regel verbunden."], ["Danach", "Migrationspaket freigeben", "Das geprüfte Paket wird erst nach der vereinbarten Umstellungsfreigabe weitergegeben."]],
    actions: ["Zuordnung freigeben", "Datensatz prüfen", "Demo-Steuerelemente sind inaktiv."], context: "SYSTEMKOMPONENTEN", systems: [["Altdatenbank", "Nur lesen"], ["Migrationsdienst", "Vorbereitet"], ["Neue Anwendung", "Bereit"], ["Rückfallweg", "Verfügbar"]], boundary: "GRENZE", limits: [["Verantwortung", "Betriebsleitung"], ["Altsystemzugriff", "Nur lesen"], ["Änderungen", "Vorbereitet"], ["Umstellung", "Menschlich"]], walkthrough: ["Snapshot gelesen", "Regeln angewendet", "Validierung bestanden", "Menschliche Prüfung", "Entscheidungen erfassen", "Paket freigeben"],
  },
  tr: {
    title: "Şirket İçi Sipariş Sistemi Yenileme · Geçiş Çalışması #042", note: "Herkese açık gösterime uygun temsili veriler. Kullanılabilen sistemler, bağlantılar ve kontroller kuruluma göre değişir.", queue: "VERİ GEÇİŞLERİ · 4", states: ["Tamamlandı", "İstisnalar inceleniyor", "Hazırlandı", "Onay bekliyor"], heading: "On iki eski kayıt için sorumlu kararı gerekiyor", review: "İnsan incelemesi",
    steps: [["08:00", "Eski sistem görüntüsü okundu", "Onaylı dışa aktarım mevcut sistem değiştirilmeden yüklendi."], ["08:05", "Geçiş kuralları uygulandı", "Alanlar, ilişkiler ve bilinen iş kuralları yeni modele eşlendi."], ["08:11", "Doğrulama tamamlandı", "2.486 kayıt yapı ve mutabakat kontrollerini geçti."], ["08:12", "İstisna kuyruğu hazırlandı", "Bir sorumlu, sahipliği eksik veya belirsiz on iki kaydı inceliyor."], ["Sonraki", "Kararları kaydet", "Onaylanan her düzeltme kaynak kayıt ve kuralla ilişkili kalır."], ["Sonraki", "Geçiş paketini yayınla", "Doğrulanmış paket yalnızca kararlaştırılan geçiş onayından sonra ilerler."]],
    actions: ["Eşlemeyi onayla", "Kaydı incele", "Demo kontrolleri etkin değildir."], context: "SİSTEM BİLEŞENLERİ", systems: [["Eski veritabanı", "Salt okunur"], ["Geçiş hizmeti", "Hazırlandı"], ["Yeni uygulama", "Hazır"], ["Geri dönüş", "Mevcut"]], boundary: "SINIR", limits: [["Sorumlu", "Operasyon yöneticisi"], ["Eski sistem erişimi", "Salt okunur"], ["Değişiklikler", "Hazırlandı"], ["Canlıya geçiş", "İnsan onayı"]], walkthrough: ["Görüntü okundu", "Kurallar uygulandı", "Doğrulama geçti", "İnsan incelemesi", "Kararları kaydet", "Paketi yayınla"],
  },
};

export function renderConsoleEvidence(locale: ConsoleLocale = "en") {
  const copy = consoleCopy[locale];
  const queueIds = ["RUN-039", "RUN-042", "RUN-043", "CUTOVER"];
  return `<figure class="console-proof" aria-labelledby="console-proof-title" data-view-event="platform_console_view">
    <figcaption><span class="proof-label">ORKESTR CONSOLE · PUBLIC DEMO</span><strong id="console-proof-title">${copy.title}</strong><small>${copy.note}</small></figcaption>
    <div class="console-grid">
      <section class="console-sidebar" aria-label="Managed system queue">
        <p class="console-kicker">${copy.queue}</p>
        ${copy.states.map((state, index) => `<div class="queue-item ${index === 1 ? "selected" : "muted"}"><span>${queueIds[index]}</span><strong>${state}</strong></div>`).join("")}
      </section>
      <section class="console-main" aria-label="Selected managed-system run">
        <div class="console-header"><div><p>${copy.title}</p><h3>${copy.heading}</h3></div><span class="status status-approval">${copy.review}</span></div>
        <ol class="timeline">
          ${copy.steps.map(([time, title, text], index) => `<li class="${index < 3 ? "complete" : index === 3 ? "current" : ""}"><span>${time}</span><div><strong>${title}</strong><p>${text}</p>${index === 3 ? `<div class="proof-actions"><button type="button" disabled>${copy.actions[0]}</button><button type="button" disabled>${copy.actions[1]}</button><small>${copy.actions[2]}</small></div>` : ""}</div></li>`).join("")}
        </ol>
      </section>
      <aside class="console-context" aria-label="Managed system context">
        <p class="console-kicker">${copy.context}</p><ul>${copy.systems.map(([name, state]) => `<li>${name} <span>${state}</span></li>`).join("")}</ul>
        <p class="console-kicker">${copy.boundary}</p><ul>${copy.limits.map(([name, state]) => `<li>${name} <span>${state}</span></li>`).join("")}</ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Execution state summary">
      ${copy.walkthrough.map((text, index) => `<li${index === 3 ? ' class="waiting"' : ""}><span>${index < 3 ? "✓" : index === 3 ? "●" : "○"}</span><strong>${text}</strong></li>`).join("")}
    </ol>
  </figure>`;
}
