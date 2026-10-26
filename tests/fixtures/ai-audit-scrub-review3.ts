/**
 * The third review of phase 2's scrub (Oct 25): the reviewer's fresh corpora, pinned.
 *
 * - REVIEW3_LEAKS: ways of saying a secret that the scrub must take out (86 of the 96 the reviewer wrote;
 *   the rest are named in REVIEW3_KNOWN_MISSES, and the operating handbook says why the call never asks for one).
 * - REVIEW3_KEEP: ordinary sentences from a discovery call that must come through unchanged
 *   (131 of 146; the rest are card-shaped numbers, routing numbers and long keys, cut on purpose).
 * - REVIEW3_CALLS and REVIEW3_DIALOGUES: whole conversations, kept line for line.
 * - REVIEW3_DIGIT_SYMBOL: a password that starts with digits then a symbol goes whole, never half.
 */
export const REVIEW3_LEAKS: Array<{ name: string; input: string; secrets: string[] }> = [
  {
    "name": "A famous phrase with password label",
    "input": "Dana: my password is correct horse battery staple",
    "secrets": [
      "horse",
      "battery",
      "staple"
    ]
  },
  {
    "name": "A plain word welcome",
    "input": "Dana: the password is welcome",
    "secrets": [
      "welcome"
    ]
  },
  {
    "name": "A plain word dragon",
    "input": "Dana: password is dragon",
    "secrets": [
      "dragon"
    ]
  },
  {
    "name": "A plain word secret",
    "input": "Dana: my password is secret",
    "secrets": [
      "secret"
    ]
  },
  {
    "name": "B pswd",
    "input": "Dana: pswd is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B p/w",
    "input": "Dana: p/w is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B pass word",
    "input": "Dana: the pass word is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B passwrd",
    "input": "Dana: my passwrd is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B master password",
    "input": "Dana: the master password is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B login pass",
    "input": "Dana: login jane pass hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "B pw colon",
    "input": "Dana: pw: hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C equals",
    "input": "Dana: password equals hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C set to",
    "input": "Dana: the password is set to hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C reads",
    "input": "Dana: password reads hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C that's",
    "input": "Dana: the password, that's hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C should be",
    "input": "Dana: password should be hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C changed to",
    "input": "Dana: we changed the password to hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C new password",
    "input": "Dana: the new password is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C reset to",
    "input": "Dana: reset the password to hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C goes like",
    "input": "Dana: the password goes like hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C parens",
    "input": "Dana: password (hunter2)",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C arrow",
    "input": "Dana: password -> hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C fat arrow",
    "input": "Dana: password => hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C brackets",
    "input": "Dana: password [hunter2]",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C tab",
    "input": "Dana: password\thunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C which is",
    "input": "Dana: the password to the portal, which is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C slash",
    "input": "Dana: user jane / pass hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "C user pass colon",
    "input": "Dana: user: jane pass: hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "D spelled letters",
    "input": "Dana: my password is H U N T E R 2",
    "secrets": [
      "H U N T E R"
    ]
  },
  {
    "name": "D hyphen spelled",
    "input": "Dana: my password is h-u-n-t-e-r-2",
    "secrets": [
      "h-u-n-t-e-r"
    ]
  },
  {
    "name": "D capital words",
    "input": "Dana: my password is capital H lowercase u n t e r two",
    "secrets": [
      "lowercase"
    ]
  },
  {
    "name": "E number words",
    "input": "Dana: my pin is forty four twenty one",
    "secrets": [
      "forty four"
    ]
  },
  {
    "name": "E double",
    "input": "Dana: my pin is double four two one",
    "secrets": [
      "double four"
    ]
  },
  {
    "name": "E groups of two",
    "input": "Dana: my pin is 44 21",
    "secrets": [
      "44 21"
    ]
  },
  {
    "name": "E dotted",
    "input": "Dana: my pin is 4.4.2.1",
    "secrets": [
      "4.4.2.1"
    ]
  },
  {
    "name": "E oh digits",
    "input": "Dana: my pin is four oh two one",
    "secrets": [
      "four oh"
    ]
  },
  {
    "name": "F visa plain",
    "input": "Dana: my visa is 4111111111111111",
    "secrets": [
      "4111111111111111"
    ]
  },
  {
    "name": "F cvc",
    "input": "Dana: the card is 4111-1111-1111-1111 exp 12/27 cvc 123",
    "secrets": [
      "4111-1111",
      "123"
    ]
  },
  {
    "name": "F cvc2",
    "input": "Dana: CVC2 is 123",
    "secrets": [
      "123"
    ]
  },
  {
    "name": "F card ending (keep)",
    "input": "Dana: the card ending in 1111 is the old one",
    "secrets": []
  },
  {
    "name": "G aws secret",
    "input": "Dana: the AWS secret key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "secrets": [
      "wJalrXUtnFEMI"
    ]
  },
  {
    "name": "G recovery phrase",
    "input": "Dana: my recovery phrase is apple banana cherry delta echo foxtrot",
    "secrets": [
      "cherry"
    ]
  },
  {
    "name": "G seed phrase",
    "input": "Dana: the seed phrase is witch collapse practice feed shame open despair creek road again ice least",
    "secrets": [
      "collapse",
      "creek"
    ]
  },
  {
    "name": "G license key",
    "input": "Dana: license key AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    "secrets": [
      "CCCCC"
    ]
  },
  {
    "name": "G product key",
    "input": "Dana: product key is AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    "secrets": [
      "CCCCC"
    ]
  },
  {
    "name": "G activation code",
    "input": "Dana: activation code 482913",
    "secrets": [
      "482913"
    ]
  },
  {
    "name": "G gift card",
    "input": "Dana: gift card number 6006 4912 3456 7890 123",
    "secrets": [
      "3456"
    ]
  },
  {
    "name": "G vault key",
    "input": "Dana: the encryption key is correct-horse-battery-staple-9",
    "secrets": [
      "battery"
    ]
  },
  {
    "name": "H routing",
    "input": "Dana: routing 021000021 and account 12345678",
    "secrets": [
      "021000021",
      "12345678"
    ]
  },
  {
    "name": "H acct hash",
    "input": "Dana: acct# 12345678",
    "secrets": [
      "12345678"
    ]
  },
  {
    "name": "H sort code",
    "input": "Dana: sort code 12-34-56 account 12345678",
    "secrets": [
      "12345678"
    ]
  },
  {
    "name": "H aba",
    "input": "Dana: the ABA number is 021000021",
    "secrets": [
      "021000021"
    ]
  },
  {
    "name": "H transit",
    "input": "Dana: transit 12345 institution 004 account 1234567",
    "secrets": [
      "1234567"
    ]
  },
  {
    "name": "I ssn plain",
    "input": "Dana: SSN 078-05-1120",
    "secrets": [
      "078-05-1120"
    ]
  },
  {
    "name": "I ssn spoken",
    "input": "Dana: social security number is 078 05 1120",
    "secrets": [
      "078 05 1120"
    ]
  },
  {
    "name": "I sin dashes",
    "input": "Dana: SIN 046-454-286",
    "secrets": [
      "046-454-286"
    ]
  },
  {
    "name": "I maiden name",
    "input": "Dana: my mother's maiden name is Smithson",
    "secrets": [
      "Smithson"
    ]
  },
  {
    "name": "I first pet",
    "input": "Dana: the answer to my security question is Rex",
    "secrets": [
      "Rex"
    ]
  },
  {
    "name": "J json",
    "input": "Dana: {\"password\": \"hunter2\", \"user\": \"jane\"}",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J yaml",
    "input": "password: hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J env",
    "input": "PASSWORD=hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J export",
    "input": "export API_KEY=abc123def456ghi789jkl012",
    "secrets": [
      "abc123def456ghi789jkl012"
    ]
  },
  {
    "name": "J query token",
    "input": "Dana: go to https://app.example.com/?token=abc123def456ghi789",
    "secrets": [
      "abc123def456ghi789"
    ]
  },
  {
    "name": "J query password",
    "input": "Dana: https://app.example.com/login?user=jane&password=hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J postgres",
    "input": "Dana: postgres://jane:hunter2@db.example.com/prod",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J mongo srv",
    "input": "Dana: mongodb+srv://jane:hunter2@cluster0.example.net/test",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J ftp no scheme",
    "input": "Dana: ftp jane:hunter2@files.example.com",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J curl -u",
    "input": "Dana: curl -u jane:hunter2 https://api.example.com",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J authorization basic",
    "input": "Dana: Authorization: Basic amFuZTpodW50ZXIy",
    "secrets": [
      "amFuZTpodW50ZXIy"
    ]
  },
  {
    "name": "J x-api-key",
    "input": "Dana: x-api-key: abc123def456ghi789jkl012",
    "secrets": [
      "abc123def456ghi789jkl012"
    ]
  },
  {
    "name": "J ssid pass",
    "input": "Dana: SSID is GuestNet and the key is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J wpa key",
    "input": "Dana: the WPA key is hunter2hunter2",
    "secrets": [
      "hunter2hunter2"
    ]
  },
  {
    "name": "J otp",
    "input": "Dana: the one time code is 482913",
    "secrets": [
      "482913"
    ]
  },
  {
    "name": "J text me",
    "input": "Dana: I got a text with 482913 as the verification code",
    "secrets": [
      "482913"
    ]
  },
  {
    "name": "J code first",
    "input": "Dana: 482913 is my verification code",
    "secrets": [
      "482913"
    ]
  },
  {
    "name": "J pin after",
    "input": "Dana: 4421 is the PIN",
    "secrets": [
      "4421"
    ]
  },
  {
    "name": "J password after",
    "input": "Dana: hunter2 is the password",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J password after2",
    "input": "Dana: it's hunter2, that's the password",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J unicode colon",
    "input": "Dana: password\uff1ahunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J nbsp",
    "input": "Dana: password is\u00a0hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J zero width",
    "input": "Dana: pass\u200bword is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J full width digits",
    "input": "Dana: my pin is \uff14\uff14\uff12\uff11",
    "secrets": [
      "\uff14\uff14",
      "4421"
    ]
  },
  {
    "name": "J emphasis",
    "input": "Dana: the **password** is hunter2",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "name": "J all caps pin",
    "input": "Dana: THE PIN IS 4421",
    "secrets": [
      "4421"
    ]
  },
  {
    "name": "J pin number is",
    "input": "Dana: my pin number is 4421",
    "secrets": [
      "4421"
    ]
  },
  {
    "name": "J newline in value",
    "input": "Dana: password is\n\nhunter2",
    "secrets": [
      "hunter2"
    ]
  }
];

export const REVIEW3_KNOWN_MISSES: string[] = [
  "A plain word, descriptive ending: Dana: my password is elephant",
  "A plain word, ing ending: Dana: my password is fishing",
  "A plain word, ed ending: Dana: my password is Blessed",
  "A plain word private: Dana: my password is private",
  "A plain word simple: Dana: my password is simple",
  "D as in: Dana: my password is h as in hotel u as in uniform n as in november",
  "I ein: Dana: EIN is 12-3456789",
  "I passport: Dana: passport number X1234567",
  "J set password: Dana: sudo passwd jane then type hunter2",
  "J wifi: Dana: wifi: GuestNet / hunter2"
];

export const REVIEW3_KEEP: string[] = [
  "Password management is a mess here.",
  "Password management: nobody owns it.",
  "Our password habits are poor.",
  "The password storage is a spreadsheet.",
  "Password training is on the list for Q1.",
  "Our password audits happen yearly.",
  "The password reminders are manual.",
  "The password complaints come in on Mondays.",
  "Our password situation is bad.",
  "The password problem is bigger than we thought.",
  "Password security is the owner's concern.",
  "Password hygiene is poor across the team.",
  "The password process is manual.",
  "Our password workflow takes an hour a day.",
  "The password rotation schedule is every 90 days.",
  "Password recovery takes a week.",
  "Password protection is handled by the IT vendor.",
  "The password spreadsheet is on a shared drive.",
  "The password is manually reset by the office manager.",
  "The password is typically reset by IT.",
  "The password is rarely changed.",
  "The password is generally shared by email.",
  "The password is whatever the vendor sets.",
  "The password is automatically generated by the system.",
  "The password is IT's job.",
  "The password is HR territory.",
  "The password is a recurring headache.",
  "The password was a big topic at the last staff meeting.",
  "The password was Joan's responsibility until she left.",
  "The password is reset every time someone forgets it.",
  "The password is handled by an outside vendor.",
  "Our login password is shared in a Google Doc.",
  "The shared password for the CRM is posted next to the printer.",
  "We keep a password book in the safe.",
  "The password book is in the safe.",
  "I want to move from passwords to single sign-on.",
  "Staff forget their passwords weekly.",
  "Passwords: shared sheet, no rotation.",
  "Password: shared sheet, no rotation.",
  "The referral code is SPRING24 and it brings in about 20 orders a month.",
  "Our job code for installs is 4410.",
  "The billing code for a standard visit is 99213.",
  "The CPT code for that procedure is 99213.",
  "The NAICS code for our industry is 541512.",
  "The HS code on the shipment is 8471.30.",
  "The GL code for marketing is 6100.",
  "The cost code for that project is 4410 and it rolls up to overhead.",
  "Our campaign code is FALL2024 and we track it in the CRM.",
  "The customer code for Acme is ACM001.",
  "The branch code is 0042.",
  "The company code in SAP is 1000.",
  "The booking code is XJ4K2L.",
  "The invite code is 9Z8Y7X.",
  "The store code for downtown is 118.",
  "The route code for the east loop is 77.",
  "The service code on the invoice is 3300.",
  "The item code is A-1042.",
  "The department code for sales is 200.",
  "The project code is 24-107.",
  "The airport code is YYC.",
  "The currency code is CAD.",
  "The language code is en-CA.",
  "The fire code requires two exits.",
  "The code of conduct is posted in the lobby.",
  "Our code is 150000 lines of PHP.",
  "Our code is 150k lines of PHP and nobody wants to touch it.",
  "The codebase is 150000 lines of PHP.",
  "Our code review takes two days.",
  "The code for the loyalty program is Gold-2024.",
  "The tax code is 5 percent GST.",
  "The code on the invoice is the cost center.",
  "Our SIC code is 7372.",
  "The price code is 3 for wholesale.",
  "Our average account is 12,000 a year.",
  "A typical account is 20000 a year.",
  "Our biggest account is 150,000 annually.",
  "The average account is 12000 dollars.",
  "Account: 45000 outstanding",
  "Account 10234 is overdue by two months.",
  "The account is 120000 in arrears.",
  "Our main account is with TD.",
  "Each account manager handles 40 accounts.",
  "We have 4000 active accounts.",
  "The account balance is 45000.",
  "Accounts receivable is 90000 right now.",
  "The bank account is at RBC and the card processor is Square.",
  "Our social is 12,000 followers on Instagram.",
  "Our social is 12000 strong.",
  "Social 15000 followers.",
  "The social calendar is 30 posts a month.",
  "The pass is $500 a month.",
  "The monthly pass is $1,200 a year.",
  "A parking pass is $120 a month.",
  "Pass: $500",
  "The season pass is 500 dollars.",
  "The day pass is $45 and the season pass is $500.",
  "We pin 100 posts a year on Pinterest.",
  "We pin 300 posts a month.",
  "Our pin is 100 miles from the border.",
  "The combination of 3 services is popular.",
  "The card is 12000 miles old.",
  "The business card is 400 pieces a year.",
  "Tokens: 15000000 per month on the AI bill.",
  "Our token usage is 15000000 a month.",
  "The secret is 100000000 in revenue.",
  "The licence key is on the receipt.",
  "The session token expires in 30 minutes.",
  "The OTP rate is 40 percent.",
  "The bot token limit is 20000.",
  "The API key limit is 100000 requests a day.",
  "The API key is rate limited to 1000 requests per minute.",
  "Our api key count is 12.",
  "The private key is stored offline.",
  "The secret key is stored in the vault.",
  "Client secret expiry is 90 days.",
  "Invoice batch 4000 1234 5678 9010 was exported.",
  "Sales by quarter were 410000 380000 450000 last year.",
  "Revenue by year 520000 610000 580000 640000.",
  "Headcount over the years: 410 420 450 480 510 540",
  "Employee id 4100 2200 3300 4400 5500 on the roster.",
  "Call 1 (403) 555-0134 or 403.555.0134 or 4035550134.",
  "Our GST number is 123456789RT0001 and our PST is PST-1234-5678.",
  "Postal code T2P 3H4, ZIP 90210-1234.",
  "The IBAN is on the invoice footer.",
  "Version 3.2.1.4 of the ERP is installed.",
  "Our MAC address list has 40 devices.",
  "IP 10.20.30.40 and 10.20.30.41 are the printers.",
  "Serial 1234-5678-9012-3456 on the label.",
  "Part number 4111-2222-3333-4444 ships from Ohio.",
  "See https://example.com/Products/Invoice-Tools/2024/Pro-Edition-Overview-Guide for details.",
  "Tracking 1Z999AA10123456784 and 9400111899223197428490 are in the sheet."
];

export const REVIEW3_CALLS: Array<{ name: string; lines: string[] }> = [
  {
    "name": "HVAC",
    "lines": [
      "CC: Thanks for making time, Mike. Walk me through how a call becomes a job today.",
      "Mike: Sure. The phone rings, Jenny answers, writes it on a sticky note, then types it into ServiceTitan at the end of the day.",
      "CC: How many calls a week?",
      "Mike: Roughly 120 in season, maybe 60 in winter. We miss about a third after hours.",
      "CC: And the account side, who owns that?",
      "Mike: My wife handles accounts receivable. Our average account is 8,500 a year, but the commercial accounts are 40,000 plus.",
      "CC: Do customers pay by card on site?",
      "Mike: Mostly card. The reader is a Square and it drops about 10 transactions a week. The tech keys the card number in by hand when it fails.",
      "CC: Any discounts or codes?",
      "Mike: We run a referral code, the code is SAVE50, and a coupon code on the Facebook ads. The tracking code on the website is Google Tag Manager.",
      "CC: What about logins, who manages those?",
      "Mike: Honestly it's a mess. Passwords are on a sticky note in the shop. Jenny knows the main password, I'd have to ask her.",
      "CC: What's the password situation for ServiceTitan?",
      "Mike: Shared. Everybody uses the same one, which is a problem when someone leaves.",
      "CC: Do you use two-factor?",
      "Mike: The codes go to my phone, so I'm the bottleneck every morning.",
      "CC: How's social media?",
      "Mike: Social is my niece. She posts three times a week. Our social following is about 4,000.",
      "CC: Google reviews?",
      "Mike: 212 reviews, 4.8 stars. The secret is we ask every customer.",
      "CC: What would you automate first?",
      "Mike: Booking. If the booking code in the calendar matched the job code in ServiceTitan we'd save hours.",
      "CC: What's the pass rate on your quotes, how many convert?",
      "Mike: About 35 percent. We pass on maybe 10 percent of leads because they are too far.",
      "CC: Security of customer data?",
      "Mike: We have a security camera, ha. The customer database is in ServiceTitan, I don't touch it.",
      "CC: Last question, what's the key number you watch?",
      "Mike: Revenue per truck per day. Right now it's 1,450."
    ]
  },
  {
    "name": "Dental",
    "lines": [
      "CC: Tell me about the front desk.",
      "Priya: Two people. They handle phones, insurance verification and check-in. The insurance codes take forever, CDT codes, we use D0120 and D1110 all day.",
      "CC: Billing?",
      "Priya: The billing code for a cleaning is D1110. The practice management system is Dentrix. Our login is shared between 3 people and the password is changed every quarter.",
      "CC: How do patients pay?",
      "Priya: Card on file for most. We have about 1,800 cards on file and 40 expire every month.",
      "CC: Do you store those?",
      "Priya: Stripe does. We only see the last four.",
      "CC: Recall?",
      "Priya: We call patients about 300 a month. The no-show rate is 12 percent.",
      "CC: Any integrations or API stuff?",
      "Priya: The API token for the texting tool is stored by our IT guy. The token expires every 90 days and he forgets.",
      "CC: Who is your IT person?",
      "Priya: Dev, part time. He manages the passwords too. The Wi-Fi password is on the whiteboard.",
      "CC: Do you do any social?",
      "Priya: Social is 2 posts a week, mostly before and afters. Social 5000 followers.",
      "CC: What's your busiest day?",
      "Priya: Tuesday. Patients call at 8 and the line is busy until 10.",
      "CC: What do you want fixed?",
      "Priya: Answer rate. We answer maybe 70 percent of calls."
    ]
  },
  {
    "name": "Ecommerce",
    "lines": [
      "CC: What platform?",
      "Sam: Shopify. We do about 900 orders a month, average order 62 dollars.",
      "CC: Discount codes?",
      "Sam: The discount code for new customers is WELCOME10 and the influencer codes are unique, like ANNA15. The promo code usage is 22 percent of orders.",
      "CC: Customer accounts?",
      "Sam: Customers can create an account, about 30 percent do. We have 6,400 customer accounts.",
      "CC: Support?",
      "Sam: Gorgias. The shared inbox login is a headache. The password reset emails go to spam.",
      "CC: Any problems with fraud or chargebacks?",
      "Sam: Chargebacks are about 0.6 percent. Stripe flags the card number mismatch cases.",
      "CC: Shipping?",
      "Sam: Canada Post and UPS. The tracking number goes out automatically. The postal code lookup is broken on mobile.",
      "CC: Who has admin access?",
      "Sam: Me, my cofounder, and the agency. The agency has the staff account with full access, which I don't love.",
      "CC: What about your ad accounts?",
      "Sam: Meta ad account is under my personal profile. The Google Ads account is under the agency's manager account.",
      "CC: Biggest bottleneck?",
      "Sam: Customer service. 80 tickets a day, half are where is my order."
    ]
  }
];

export const REVIEW3_DIALOGUES: string[] = [
  "CC: Who manages the password?\nDana: Typically, the office manager.",
  "CC: And the account number?\nDana: Unfortunately, I don't have it.",
  "Dana: I don't remember the pin\nCC: Rarely does anyone.",
  "CC: Who has the login and password?\nDana: Joan, mostly, sometimes me.",
  "CC: Who has the password?\nDana: Mike, our IT guy.",
  "CC: Is that the shared password?\nDana: Frankly, nobody knows.",
  "Dana: The only thing I can't give you is the code\nCC: Understood.",
  "CC: What is the security answer?\nDana: Honestly I never set one.",
  "Dana: We never write down the pin\nCC: Smart.",
  "Dana: Sorry, what was that last thing, the token?\nCC: The API token.",
  "CC: Do you use a password?\nDana: Yes we do.",
  "CC: Which password?\nDana: Quickbooks.",
  "CC: Where is the password stored?\nDana: Excel.",
  "Dana: It is the same as the card\nCC: Okay.",
  "CC: So the account\nDana: Yes the account is 4421 bad debt",
  "Dana: Our biggest problem is the password\nCC: Tell me more.\nDana: Staff share one."
];

export const REVIEW3_DIGIT_SYMBOL: string[] = [
  "Dana: my password is 2024!Summer",
  "Dana: the password is 1234#BlueFalcon",
  "Dana: password: 123456_secretword",
  "Dana: password is 007&James",
  "Dana: my pin is 4421-A",
  "Dana: my passcode is 123456@Work",
  "Dana: password is 2024$ummer",
  "Dana: the wifi password is 12345678.guest",
  "Dana: password is 99Problems",
  "Dana: my password is 5!pizza",
  "Dana: password 8675309.Jenny"
];

/**
 * The reviewer's idempotency fuzz, seeded and unchanged: documents of one to
 * six lines built from labels, joiners, values and talk. Scrubbing any of them
 * twice must change nothing (651 of 20,000 did before this pass). The key-like
 * values are put together here, so no file holds one whole.
 */
const FUZZ_HEX = ["8f3a9c1d", "2b7e4f60", "a1b2c3d4", "e5f60718"].join("");
const FUZZ_PEM_START = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const FUZZ_PEM_END = ["-----END", "PRIVATE KEY-----"].join(" ");
const FUZZ_MARK = "[removed: possible password or account detail]";
const FUZZ_LABELS = ["password", "my password", "the password", "passwords", "PIN", "pin number", "passcode", "security code", "the code", "account number", "account", "card number", "SIN", "my social", "api key", "token", "secret", "pass", "security answer", "passphrase", "wifi password", "code", "combination", "CVV", "routing number", "IBAN", "the door code", "login", "bank account", "the pin"];
const FUZZ_JOINERS = [" is", " is:", ":", " =", " -", "'s", " was", " would be", " are", "", " for the portal is", " I use for everything is", " it gave me is", ", um,", "...", " is, um,", " is actually"];
const FUZZ_VALUES = ["hunter2", "4421", "4 4 2 1", "1234 5678 9012", "blue falcon river", "Tr0ub4dor&3", "4111 1111 1111 1111", FUZZ_HEX, "swordfish", "one two three four five", "alpha bravo charlie", "078-05-1120", "046 454 286", "GB82 WEST 1234 5698 7654 32", "Tuesday", "150 employees", "150", "the", "um", "sorry, say again?", "okay", "5 locations", "Invoices go out on the 5th", "we have 40 staff", "123456789", ""];
const FUZZ_TAILS = ["", " for the alarm", " and that is all", ".", ",", " so yeah", " and the pin 4421", " 5678", " okay?", " and the card number 4111 1111 1111 1111"];
const FUZZ_PREFIXES = ["", "", "Dana: ", "CC: ", "[00:01:02] Dana: ", "- ", "Note: ", "Q: ", "A: "];
const FUZZ_EXTRA = [
  "my pin is 4421", "the card number is 4111 1111", "1111 1111", "4111 1111 1111 1111", "5678", "9012 3456",
  "sorry, say again?", "um", "okay", "uh-huh", "yeah", "right", "Can you repeat that?", "one sec",
  FUZZ_PEM_START, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", FUZZ_PEM_END,
  "IBAN GB82 WEST 1234 5698 7654 32", "GB82 WEST 1234", "5698 7654 32",
  "open https://admin:hunter2@router.local please", `Authorization: Bearer ${FUZZ_HEX}`,
  "ssh root@10.0.0.5 -p 22 password hunter2", "the login is jane and the pw is Summer24",
  "the password is the same everywhere", "passwords are a pain, we reset 40 a month", "the PIN is on a sticky note",
  "our code review takes two days", "area code 403", "the social media budget is 5000", "the account is overdue",
  "my social is", "the account number is", "the code for the safe is", "the api key is", "security answer:",
  `${FUZZ_MARK} ${FUZZ_MARK}`,
  `the password is ${FUZZ_MARK} and the pin is`, `pin is ${FUZZ_MARK} 4421`,
  "four one one one", "one one one one", "alpha bravo charlie delta", "oh four two one",
];

export function review3FuzzDocs(n: number, keep: readonly string[], seed = 20261025): string[][] {
  let x = seed >>> 0;
  const rnd = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
  const below = (k: number) => Math.floor(rnd() / (1 / k));
  const pick = <T,>(a: readonly T[]): T => a[below(a.length)];
  const line = (): string => {
    const r = rnd();
    const pre = pick(FUZZ_PREFIXES);
    if (r < 0.1) return pre + pick(FUZZ_VALUES);
    if (r < 0.16) return pre + FUZZ_MARK;
    if (r < 0.22) return pre + pick(keep);
    if (r < 0.4) return pre + pick(FUZZ_EXTRA);
    if (r < 0.55) return pre + pick(FUZZ_LABELS) + pick(FUZZ_JOINERS);
    return pre + pick(FUZZ_LABELS) + pick(FUZZ_JOINERS) + " " + pick(FUZZ_VALUES) + pick(FUZZ_TAILS);
  };
  return Array.from({ length: n }, () => Array.from({ length: 1 + below(6) }, line));
}
