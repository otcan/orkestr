#!/usr/bin/env python3
"""Regenerate the synthetic job-mail fixtures (fictional companies and people only).

    python3 -I -B v2/crates/mail-reader/tests/fixtures/generate.py

Writes one .eml per case into tests/fixtures/mail/ and the expected labels
into tests/fixtures/expected.json. Never put real mail here.
"""
import base64
import email.utils
import hashlib
import json
import pathlib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

HERE = pathlib.Path(__file__).resolve().parent
TO = "Alex Example <alex.jobseeker@example.com>"
START = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)


def auth(domain, ok=True):
    r = "pass" if ok else "fail"
    return f"mx.google.com; dkim={r} header.i=@{domain}; spf={r} smtp.mailfrom={domain}; dmarc={r} header.from={domain}"


# name, minutes, from, auth domain, dkim ok, subject, plain body, html body, expected
CASES = [
    ("linkedin-applied", 0, "LinkedIn <jobs-noreply@linkedin.com>", "linkedin.com", True,
     "Alex, your application was sent to Acme Robotics GmbH",
     "Your application was sent to Acme Robotics GmbH\n\nBackend Engineer (Rust)\nAcme Robotics GmbH · Berlin, Germany (Hybrid)\n\n"
     "View job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&refId=xyz\n\nApplied on October 20, 2026", None,
     {"kind": "applied", "company": "Acme Robotics GmbH", "role": "Backend Engineer (Rust)", "source": "linkedin",
      "link": "https://linkedin.com/jobs/view/4012345678"}),
    ("linkedin-viewed", 30, "LinkedIn <jobs-noreply@linkedin.com>", "linkedin.com", True,
     "Your application was viewed by Contoso Analytics",
     "Contoso Analytics viewed your application\n\nData Engineer\nContoso Analytics · Munich, Germany\n\n"
     "https://www.linkedin.com/jobs/view/4011111111/\n\nThis doesn't guarantee a response.", None,
     {"kind": "viewed", "company": "Contoso Analytics", "role": "Data Engineer", "source": "linkedin"}),
    ("greenhouse-received", 60, "Greenhouse <no-reply@us.greenhouse-mail.io>", "us.greenhouse-mail.io", True,
     "Thank you for applying to Northwind Labs",
     "Hi Alex,\n\nThank you for applying to the Platform Engineer position at Northwind Labs. We have received your application "
     "and our team will review it shortly.\n\nhttps://job-boards.greenhouse.io/northwindlabs/jobs/7712345\n\nBest,\nNorthwind Labs Recruiting", None,
     {"kind": "application_received", "company": "Northwind Labs", "role": "Platform Engineer", "source": "ats:greenhouse",
      "link": "https://job-boards.greenhouse.io/northwindlabs/jobs/7712345"}),
    ("workday-received", 90, "Fabrikam Careers <fabrikam@myworkday.com>", "myworkday.com", True,
     "Application received: Senior Frontend Developer (R-10442)",
     "Dear Alex,\n\nWe have received your application for Senior Frontend Developer (R-10442) at Fabrikam AG.\n"
     "You can track your application status here: https://fabrikam.wd3.myworkdayjobs.com/en-US/careers/userHome\n\nFabrikam Talent Acquisition", None,
     {"kind": "application_received", "company": "Fabrikam AG", "role": "Senior Frontend Developer (R-10442)", "source": "ats:workday"}),
    ("linkedin-alert", 120, "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "linkedin.com", True,
     "15 new jobs for 'rust developer'",
     "Your job alert for rust developer in Germany\n\nRust Developer - Tailspin Toys - Hamburg\nhttps://www.linkedin.com/comm/jobs/view/4019999991/\n"
     "Systems Engineer - Wingtip Solutions - Remote\nhttps://www.linkedin.com/comm/jobs/view/4019999992/\n\nSee all jobs", None,
     {"kind": "job_alert", "items": [["Tailspin Toys", "Rust Developer", "https://linkedin.com/jobs/view/4019999991"],
                                     ["Wingtip Solutions", "Systems Engineer", "https://linkedin.com/jobs/view/4019999992"]]}),
    ("linkedin-social", 150, "LinkedIn <notifications-noreply@linkedin.com>", "linkedin.com", True,
     "Jamie Doe reacted to your post", "Jamie Doe and 3 others reacted to your post. See all reactions.", None,
     {"drop": "drop:social"}),
    ("newsletter", 180, "Example Weekly <newsletter@news.example.org>", "news.example.org", True,
     "This week in tech: 10 tools you should know", "Our weekly digest. Unsubscribe at any time.", None,
     {"drop": "drop:newsletter"}),
    ("greenhouse-interview", 1440, "Northwind Labs <no-reply@us.greenhouse-mail.io>", "us.greenhouse-mail.io", True,
     "Interview invitation – Platform Engineer at Northwind Labs",
     "Hi Alex,\n\nThanks again for your interest in the Platform Engineer role. We'd like to invite you to a first interview "
     "with our engineering manager. Please pick a slot that works for you: https://calendly.com/northwind-recruiting/30min\n\nKind regards,\nSam", None,
     {"kind": "interview_invite", "company": "Northwind Labs", "role": "Platform Engineer", "source": "ats:greenhouse"}),
    ("personio-rejection-de", 1500, "Personio <bluebird-jobs@m.personio.com>", "m.personio.com", True,
     "Ihre Bewerbung bei Bluebird Logistik GmbH",
     "Hallo Alex,\n\nvielen Dank für Ihre Bewerbung als DevOps Engineer (m/w/d). Leider müssen wir Ihnen mitteilen, dass wir uns "
     "für andere Kandidat:innen entschieden haben. Wir wünschen Ihnen viel Erfolg.\n\nMit freundlichen Grüßen\nBluebird Logistik GmbH", None,
     {"kind": "rejection", "company": "Bluebird Logistik GmbH", "role": "DevOps Engineer (m/w/d)", "source": "ats:personio"}),
    ("ashby-assessment", 1560, "Ashby <no-reply@ashbyhq.com>", "ashbyhq.com", True,
     "Next step: coding assessment for Software Engineer at Litware",
     "Hi Alex,\n\nAs a next step for the Software Engineer role at Litware, please complete the HackerRank coding assessment "
     "within 5 days: https://www.hackerrank.com/test/abc123/login\n\nThe Litware team", None,
     {"kind": "assessment", "company": "Litware", "role": "Software Engineer", "source": "ats:ashby"}),
    ("lever-rejection", 1620, "Lever <no-reply@hire.lever.co>", "hire.lever.co", True,
     "Your application to Proseware",
     "Hi Alex,\n\nThank you for your interest in the Site Reliability Engineer role at Proseware. Unfortunately, we have decided "
     "not to move forward with your application at this time.\n\nhttps://jobs.lever.co/proseware/5f2c\n\nBest wishes,\nProseware", None,
     {"kind": "rejection", "company": "Proseware", "role": "Site Reliability Engineer", "source": "ats:lever",
      "link": "https://jobs.lever.co/proseware/5f2c"}),
    ("linkedin-rejection", 1680, "LinkedIn <jobs-noreply@linkedin.com>", "linkedin.com", True,
     "Your application to Data Engineer at Contoso Analytics",
     "Your update from Contoso Analytics\n\nData Engineer\nContoso Analytics · Munich, Germany\n\n"
     "Unfortunately, Contoso Analytics has decided not to move forward with your application.\n\nhttps://www.linkedin.com/jobs/view/4011111111/", None,
     {"kind": "rejection", "company": "Contoso Analytics", "role": "Data Engineer", "source": "linkedin"}),
    ("linkedin-inmail", 1740, "Riley Recruiter via LinkedIn <inmail-hit-reply@linkedin.com>", "linkedin.com", True,
     "Riley sent you a new message",
     "Riley Recruiter, Talent Partner at Adatum Corp\n\nHi Alex, I came across your profile and think you'd be a great fit for "
     "our Staff Backend Engineer role at Adatum Corp. Are you open to a quick call?\n\nReply on LinkedIn", None,
     {"kind": "job_alert", "company": "Adatum Corp", "role": "Staff Backend Engineer", "source": "linkedin"}),
    ("direct-offer", 1800, "Acme Robotics GmbH <careers@acme-robotics.example>", "acme-robotics.example", True,
     "Offer – Backend Engineer (Rust)",
     "Dear Alex,\n\nWe are delighted to offer you the position of Backend Engineer (Rust) at Acme Robotics GmbH. "
     "Please find the offer letter attached and let us know by Friday.\n\nBest regards,\nAcme Robotics HR", None,
     {"kind": "offer", "company": "Acme Robotics GmbH", "role": "Backend Engineer (Rust)", "source": "direct", "requires_thread": True,
      "headers": {"In-Reply-To": "<jt15fixture.sent-acme@example.com>"}}),
    ("linkedin-spoof", 1860, "LinkedIn <jobs-noreply@linkedin.com>", "linkedin-security-check.example", False,
     "Your application was viewed by Globex Corp",
     "Globex Corp viewed your application. Verify your account to see details: http://linkedin-security-check.example/login", None,
     {"drop": "sender_not_authenticated"}),
    ("greenhouse-own-domain-html", 1900, "Tailspin Toys Careers <careers@tailspin-toys.example>", "tailspin-toys.example", True,
     "Thank you for your application", None,
     "<html><body><p>Hi Alex,</p><p>Thank you for applying to the QA Engineer position at Tailspin Toys. We will be in touch.</p>"
     "<p><a href=\"https://boards.greenhouse.io/tailspintoys/jobs/4455?gh_src=mail&amp;utm_medium=email\">View the posting</a></p></body></html>",
     {"kind": "application_received", "company": "Tailspin Toys", "role": "QA Engineer", "source": "ats:greenhouse",
      "link": "https://boards.greenhouse.io/tailspintoys/jobs/4455"}),
    ("workday-received-de-qp", 1920, "Contoso Karriere <contoso@myworkday.com>", "myworkday.com", True,
     "Eingangsbestätigung Ihrer Bewerbung",
     "Hallo Alex,\n\nvielen Dank für Ihre Bewerbung als Projektmanager (m/w/d) bei Contoso GmbH.\nWir melden uns in Kürze.\n\nIhr Recruiting-Team", None,
     {"kind": "application_received", "company": "Contoso GmbH", "role": "Projektmanager (m/w/d)", "source": "ats:workday"}),
    ("codility-assessment", 1980, "Codility <no-reply@codility.com>", "codility.com", True,
     "Coding challenge from Wingtip Solutions",
     "Hello Alex,\n\nWingtip Solutions has invited you to complete a coding challenge for the Systems Engineer role at Wingtip Solutions.\n"
     "Start here: https://app.codility.com/c/run/ABC-123\n", None,
     {"kind": "assessment", "company": "Wingtip Solutions", "role": "Systems Engineer", "source": "assessment:codility"}),
    ("recruiter-direct", 2040, "Jane Smith <jane@talentbridge.example>", "talentbridge.example", True,
     "Opportunity: Senior Rust Engineer at Fourth Coffee",
     "Hi Alex,\n\nI'm a recruiter at TalentBridge. Our client Fourth Coffee is hiring for a Senior Rust Engineer position in Berlin. "
     "Would you be open to a short call this week?\n\nBest,\nJane", None,
     {"kind": "job_alert", "company": "Fourth Coffee", "role": "Senior Rust Engineer", "source": "direct",
      "max_confidence": 65}),
    ("linkedin-alert-dot", 2100, "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "linkedin.com", True,
     "Data Scientist: Fabrikam AG",
     "Your job alert for data scientist\n\nData Scientist · Fabrikam AG · Munich\nhttps://www.linkedin.com/comm/jobs/view/4018888881/?trk=eml\n", None,
     {"kind": "job_alert", "items": [["Fabrikam AG", "Data Scientist", "https://linkedin.com/jobs/view/4018888881"]]}),
    ("greenhouse-spoofed-rejection", 2160, "Greenhouse <no-reply@us.greenhouse-mail.io>", "evil-relay.example", False,
     "Your application to Litware",
     "Hi Alex,\n\nUnfortunately we have decided not to move forward for the Software Engineer role at Litware.\n", None,
     {"drop": "not_in_thread"}),
    ("interview-de-direct", 2220, "Bluebird Logistik GmbH <jobs@bluebird-logistik.example>", "bluebird-logistik.example", True,
     "Einladung zum Vorstellungsgespräch",
     "Hallo Alex,\n\nwir möchten Sie gerne zu einem Vorstellungsgespräch einladen. Bitte nennen Sie uns Ihre Verfügbarkeit.\n", None,
     {"drop": "not_in_thread"}),
    ("teamtailor-received", 2280, "Margie's Travel <no-reply@message.teamtailor.com>", "message.teamtailor.com", True,
     "Thanks for applying to Margie's Travel",
     "Hi Alex,\n\nThanks for your application for the Travel Consultant role at Margie's Travel. We will review it soon.\n", None,
     {"kind": "application_received", "company": "Margie's Travel", "role": "Travel Consultant", "source": "ats:teamtailor"}),
    ("personal", 2340, "Sam Friend <sam@example.net>", "example.net", True,
     "Dinner on Friday?", "Hey Alex, are you free for dinner on Friday? Sam", None, {"drop": "not_job_related"}),
    ("interview-tips-newsletter", 2400, "Career Blog <hello@careers-blog.example>", "careers-blog.example", True,
     "10 tips for your next interview",
     "Prepare well, research the company and practise your answers.\n\nManage preferences or unsubscribe here.", None,
     {"drop": "drop:newsletter"}),
    ("ashby-received-multipart", 1500, "Litware <no-reply@ashbyhq.com>", "ashbyhq.com", True,
     "Thanks for applying to Litware",
     "Hi Alex,\n\nThanks for applying to the Software Engineer role at Litware. We have received your application.\n",
     "<p>Hi Alex,</p><p>Thanks for applying to the Software Engineer role at Litware.</p>",
     {"kind": "application_received", "company": "Litware", "role": "Software Engineer", "source": "ats:ashby"}),
    ("smartrecruiters-review", 2460, "Adventure Works <noreply@smartrecruiters.com>", "smartrecruiters.com", True,
     "Application status update",
     "Hi Alex,\n\nYour application for Cloud Architect at Adventure Works is under review. We will get back to you soon.\n", None,
     {"kind": "in_review", "company": "Adventure Works", "role": "Cloud Architect", "source": "ats:smartrecruiters"}),
    ("workday-rejection", 2520, "Fabrikam Careers <fabrikam@myworkday.com>", "myworkday.com", True,
     "Update on your application",
     "Dear Alex,\n\nWe regret to inform you that we have decided to pursue other candidates for the Senior Frontend Developer (R-10442) "
     "position at Fabrikam AG.\n\nFabrikam Talent Acquisition", None,
     {"kind": "rejection", "company": "Fabrikam AG", "role": "Senior Frontend Developer (R-10442)", "source": "ats:workday"}),
    ("lever-received-tracking", 2580, "Proseware <no-reply@hire.lever.co>", "hire.lever.co", True,
     "Thank you for applying to Proseware",
     "Hi Alex,\n\nThank you for applying to the Site Reliability Engineer position at Proseware.\n"
     "Posting: https://jobs.lever.co/proseware/5f2c/?utm_source=linkedin&lever-origin=applied\n", None,
     {"kind": "application_received", "company": "Proseware", "role": "Site Reliability Engineer", "source": "ats:lever",
      "link": "https://jobs.lever.co/proseware/5f2c?lever-origin=applied"}),
    ("encoded-subject-linkedin", 2640, "LinkedIn <jobs-noreply@linkedin.com>", "linkedin.com", True,
     "Alex, your application was sent to Bäckerei Müller GmbH",
     "Your application was sent to Bäckerei Müller GmbH\n\nVerkäufer (m/w/d)\nBäckerei Müller GmbH · Köln\n\n"
     "https://www.linkedin.com/comm/jobs/view/4017777771/\n", None,
     {"kind": "applied", "company": "Bäckerei Müller GmbH", "role": "Verkäufer (m/w/d)", "source": "linkedin"}),
    # --- ORK-605 real-mail failure modes, synthetic: own applications from the
    # Sent folder, thread-gated replies, bulk marketing, DE agencies.
    ("sent-acme-application", 1700, "Alex Example <alex.jobseeker@example.com>", "example.com", True,
     "Bewerbung als Backend Engineer (Rust)",
     "Sehr geehrte Damen und Herren,\n\nanbei mein Lebenslauf für die Stelle als Backend Engineer (Rust).\n\nViele Grüße\nAlex", None,
     {"kind": "applied", "company": "Acme Robotics GmbH", "role": "Backend Engineer (Rust)", "source": "direct", "outgoing": True,
      "to": "Acme Robotics GmbH <careers@acme-robotics.example>", "message_id": "<jt15fixture.sent-acme@example.com>"}),
    ("sent-hays-application", 2700, "Alex Example <alex.jobseeker@example.com>", "example.com", True,
     "Bewerbung: Senior Java Entwickler (Projekt 4711)",
     "Hallo Projektteam,\n\nanbei mein Profil für das Projekt. Stundensatz 95 EUR, verfügbar ab 01.12.\n\nGruß\nAlex", None,
     {"kind": "applied", "company": "Hays", "role": "Senior Java Entwickler (Projekt 4711)", "source": "agency:hays", "outgoing": True,
      "to": "Hays Projektteam <projekte@hays.de>", "message_id": "<jt15fixture.sent-hays@example.com>"}),
    ("hays-rejection-in-thread", 2760, "Hays Projektteam <projekte@hays.de>", "hays.de", True,
     "AW: Bewerbung: Senior Java Entwickler (Projekt 4711)",
     "Hallo Alex,\n\nvielen Dank. Leider hat sich der Kunde für einen anderen Kandidaten entschieden.\n\nViele Grüße\nHays", None,
     {"kind": "rejection", "company": "Hays", "role": "Senior Java Entwickler (Projekt 4711)", "source": "agency:hays", "requires_thread": True,
      "headers": {"In-Reply-To": "<jt15fixture.sent-hays@example.com>", "References": "<jt15fixture.sent-hays@example.com>"}}),
    ("sent-sthree-application", 2820, "Alex Example <alex.jobseeker@example.com>", "example.com", True,
     "Application: DevOps Engineer (Remote)",
     "Hi,\n\nplease find attached my CV for the DevOps role. My daily rate is 750 EUR.\n\nBest\nAlex", None,
     {"kind": "applied", "company": "SThree", "role": "DevOps Engineer (Remote)", "source": "agency:sthree", "outgoing": True,
      "to": "Computer Futures <jobs@computerfutures.com>", "message_id": "<jt15fixture.sent-sthree@example.com>"}),
    ("sthree-onboarding-in-thread", 2880, "Computer Futures <jobs@computerfutures.com>", "computerfutures.com", True,
     "RE: Application: DevOps Engineer (Remote)",
     "Hi Alex,\n\nGreat news - the client has confirmed you for the project. Unfortunately the start date moves by one week. "
     "Please complete the onboarding documents.\n\nBest regards", None,
     {"kind": "offer", "company": "SThree", "role": "DevOps Engineer (Remote)", "source": "agency:sthree", "requires_thread": True,
      "headers": {"In-Reply-To": "<jt15fixture.sent-sthree@example.com>"}}),
    ("marketing-offer-bulk", 2940, "Deals <news@shop-deals.example>", "shop-deals.example", True,
     "We are happy to offer you 20% off", "We are happy to offer you 20% off your next order.", None,
     {"drop": "drop:marketing", "headers": {"List-Unsubscribe": "<https://shop-deals.example/unsub>"}}),
    ("calendly-sales-pitch", 3000, "Sam Sales <sam@growthtools.example>", "growthtools.example", True,
     "Quick call this week?",
     "Hi Alex,\n\nI help consultants win more clients. Pick a slot: https://calendly.com/growthtools/15min\n\nSam", None,
     {"drop": "not_in_thread"}),
    ("hackathon-newsletter", 3060, "Hackathon Weekly <team@hackathons.example>", "hackathons.example", True,
     "New coding challenge: build an AI agent",
     "Join this week's coding challenge and win prizes.", None,
     {"drop": "drop:marketing", "headers": {"List-Id": "<weekly.hackathons.example>"}}),
    ("emagine-project-lead", 3120, "emagine Recruiting <jobs@emagine.org>", "emagine.org", True,
     "Projektanfrage: Data Engineer (Remote, 6 Monate)",
     "Hallo Alex,\n\nfür ein Projekt bei unserem Kunden suchen wir einen Data Engineer. Hast du Interesse?\n\nViele Grüße", None,
     {"kind": "job_alert", "company": "emagine", "role": "Data Engineer (Remote, 6 Monate)", "source": "agency:emagine",
      "message_id": "<jt15fixture.emagine-lead@emagine.org>"}),
    ("sent-reply-to-emagine-lead", 3180, "Alex Example <alex.jobseeker@example.com>", "example.com", True,
     "AW: Projektanfrage: Data Engineer (Remote, 6 Monate)",
     "Hallo,\n\nja, gerne. Anbei mein Profil, Tagessatz 800 EUR.\n\nAlex", None,
     {"kind": "applied", "company": "emagine", "role": "Data Engineer (Remote, 6 Monate)", "source": "agency:emagine", "outgoing": True,
      "to": "emagine Recruiting <jobs@emagine.org>", "headers": {"In-Reply-To": "<jt15fixture.emagine-lead@emagine.org>"}}),
    ("platform-digest-bulk", 3240, "freelance.de <noreply@freelance.de>", "freelance.de", True,
     "12 neue Projekte für Sie", "Neue Projekte: Java Entwickler, DevOps Engineer, Data Engineer ...", None,
     {"drop": "drop:marketing", "headers": {"List-Unsubscribe": "<https://www.freelance.de/unsub>", "Precedence": "bulk"}}),
    ("sent-private", 3300, "Alex Example <alex.jobseeker@example.com>", "example.com", True,
     "Bewerbung abgeschickt!", "Ich habe heute drei Bewerbungen abgeschickt.", None,
     {"drop": "private_recipient", "outgoing": True, "to": "Synthetic Friend <synthetic-friend@web.de>"}),
    ("linkedin-sales-inmail", 3360, "Pat Growth via LinkedIn <inmail-hit-reply@linkedin.com>", "linkedin.com", True,
     "Pat sent you a new message",
     "Hi Alex, a great opportunity to grow your consulting business. Let's book a time: https://calendly.com/patgrowth/30min", None,
     {"drop": "lead_without_role"}),
]


def build(name, minutes, sender, auth_domain, ok, subject, plain, html, expected):
    m = EmailMessage()
    if not expected.get("outgoing"):
        m["Authentication-Results"] = auth(auth_domain, ok)
    m["From"] = sender
    m["To"] = expected.get("to", TO)
    m["Subject"] = subject
    m["Date"] = email.utils.format_datetime(START + timedelta(minutes=minutes))
    m["Message-ID"] = expected.get("message_id") or f"<jt15fixture.{hashlib.sha1(name.encode()).hexdigest()[:16]}@{auth_domain}>"
    for key, value in expected.get("headers", {}).items():
        m[key] = value
    if name.endswith("-qp"):
        m.set_content(plain, cte="quoted-printable")
    elif plain is not None:
        m.set_content(plain)
    if html is not None:
        if plain is None:
            m.set_content(html, subtype="html", cte="base64")
        else:
            m.add_alternative(html, subtype="html")
    return m


def main():
    out = HERE / "mail"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.eml"):
        old.unlink()
    expected = {}
    for index, case in enumerate(CASES):
        name = case[0]
        file = f"{index:02d}-{name}.eml"
        (out / file).write_bytes(bytes(build(*case[:9])))
        expected[file] = {k: v for k, v in case[8].items() if k not in ("headers", "to", "message_id")}
    (HERE / "expected.json").write_text(json.dumps(expected, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(CASES)} fixtures")


if __name__ == "__main__":
    main()
