import type { PiiLabel } from "../src/types";

export interface EvalTerm {
  readonly text: string;
  readonly label: PiiLabel;
}

export interface PublicEvalCase {
  readonly id: string;
  readonly input: string;
  readonly privateTerms: readonly EvalTerm[];
  readonly publicTerms: readonly string[];
}

export const PUBLIC_E2E_CASES: readonly PublicEvalCase[] = [
  {
    id: "chat-name-email-income",
    input: "My name is Alex Rivera, my email is alex.rivera@example.com, and my monthly income is $1,950.",
    privateTerms: [
      { text: "Alex", label: "GIVEN_NAME" },
      { text: "Rivera", label: "SURNAME" },
      { text: "alex.rivera@example.com", label: "EMAIL" },
    ],
    publicTerms: ["$1,950"],
  },
  {
    id: "chat-ssn-phone",
    input: "My SSN is 472-81-0094 and you can call me at (202) 555-0188.",
    privateTerms: [
      { text: "472-81-0094", label: "SSN" },
      { text: "(202) 555-0188", label: "PHONE" },
    ],
    publicTerms: [],
  },
  {
    id: "chat-card-spaces",
    input: "The card number is 4111 1111 1111 1111, but my eligibility question is about rent.",
    privateTerms: [{ text: "4111 1111 1111 1111", label: "CREDIT_CARD" }],
    publicTerms: ["eligibility question", "rent"],
  },
  {
    id: "chat-routing-number",
    input: "My bank routing number is 021000021 for direct deposit.",
    privateTerms: [{ text: "021000021", label: "ROUTING_NUMBER" }],
    publicTerms: ["direct deposit"],
  },
  {
    id: "chat-street-keeps-geography",
    input: "I live at 31 Birchwood Avenue Old Lyme CT 06371 and make $45,000.",
    privateTerms: [
      { text: "31", label: "BUILDING_NUMBER" },
      { text: "Birchwood Avenue", label: "STREET_NAME" },
    ],
    publicTerms: ["Old Lyme", "CT", "06371", "$45,000"],
  },
  {
    id: "chat-city-state-zip-only",
    input: "I live in Old Lyme CT 06371 and make $45,000.",
    privateTerms: [],
    publicTerms: ["Old Lyme", "CT", "06371", "$45,000"],
  },
  {
    id: "chat-hyphenated-name",
    input: "My name is Thanh-Nghiem Quoc-Bao and I need help with my application.",
    privateTerms: [
      { text: "Thanh-Nghiem", label: "GIVEN_NAME" },
      { text: "Quoc-Bao", label: "SURNAME" },
    ],
    publicTerms: ["need help with my application"],
  },
  {
    id: "chat-particle-name",
    input: "Please update the record for Jean-Baptiste De La Croix.",
    privateTerms: [
      { text: "Jean-Baptiste", label: "GIVEN_NAME" },
      { text: "De La Croix", label: "SURNAME" },
    ],
    publicTerms: ["update the record"],
  },
  {
    id: "chat-apostrophe-name",
    input: "The applicant is Saoirse O'Neill and the household size is four.",
    privateTerms: [
      { text: "Saoirse", label: "GIVEN_NAME" },
      { text: "O'Neill", label: "SURNAME" },
    ],
    publicTerms: ["household size is four"],
  },
  {
    id: "chat-diacritic-name",
    input: "I am Saoirse Ni Bhraonain and I have a voucher question.",
    privateTerms: [
      { text: "Saoirse", label: "GIVEN_NAME" },
      { text: "Ni Bhraonain", label: "SURNAME" },
    ],
    publicTerms: ["voucher question"],
  },
  {
    id: "chat-east-asian-name",
    input: "Yu-Shan Liang is listed as the head of household.",
    privateTerms: [
      { text: "Yu-Shan", label: "GIVEN_NAME" },
      { text: "Liang", label: "SURNAME" },
    ],
    publicTerms: ["head of household"],
  },
  {
    id: "chat-south-asian-name",
    input: "Priyanka Venkataraman submitted the form yesterday.",
    privateTerms: [
      { text: "Priyanka", label: "GIVEN_NAME" },
      { text: "Venkataraman", label: "SURNAME" },
    ],
    publicTerms: ["submitted the form"],
  },
  {
    id: "chat-west-african-name",
    input: "Chukwuemeka Okonkwo-Adeyemi needs to update household income.",
    privateTerms: [
      { text: "Chukwuemeka", label: "GIVEN_NAME" },
      { text: "Okonkwo-Adeyemi", label: "SURNAME" },
    ],
    publicTerms: ["household income"],
  },
  {
    id: "chat-hispanic-name",
    input: "Luis Garcia has a Section 8 voucher appointment next week.",
    privateTerms: [
      { text: "Luis", label: "GIVEN_NAME" },
      { text: "Garcia", label: "SURNAME" },
    ],
    publicTerms: ["Section 8 voucher appointment"],
  },
  {
    id: "chat-middle-eastern-name",
    input: "Noura Al-Hassan asked about utility allowances.",
    privateTerms: [
      { text: "Noura", label: "GIVEN_NAME" },
      { text: "Al-Hassan", label: "SURNAME" },
    ],
    publicTerms: ["utility allowances"],
  },
  {
    id: "chat-public-official-kept-by-policy-fixture",
    input: "The Housing Secretary spoke in Washington about housing.",
    privateTerms: [],
    publicTerms: ["The Housing Secretary", "Washington", "housing"],
  },
  {
    id: "chat-private-landlord",
    input: "My landlord Thomas Green filed an eviction notice.",
    privateTerms: [
      { text: "Thomas", label: "GIVEN_NAME" },
      { text: "Green", label: "SURNAME" },
    ],
    publicTerms: ["eviction notice"],
  },
  {
    id: "chat-public-organization",
    input: "I found this information on benefits.gov and the state housing website.",
    privateTerms: [],
    publicTerms: ["benefits.gov", "state housing website"],
  },
  {
    id: "chat-case-number",
    input: "My case number is AGY-2026-009871 and my household member is Maya Chen.",
    privateTerms: [
      { text: "AGY-2026-009871", label: "GOVERNMENT_ID" },
      { text: "Maya", label: "GIVEN_NAME" },
      { text: "Chen", label: "SURNAME" },
    ],
    publicTerms: ["household member"],
  },
  {
    id: "chat-uscis-receipt",
    input: "My USCIS receipt is IOE0912345678, and I need to know if that affects housing eligibility.",
    privateTerms: [{ text: "IOE0912345678", label: "GOVERNMENT_ID" }],
    publicTerms: ["housing eligibility"],
  },
  {
    id: "chat-medicare-number",
    input: "My Medicare number is 1EG4-TE5-MK73 and I am applying for housing.",
    privateTerms: [{ text: "1EG4-TE5-MK73", label: "GOVERNMENT_ID" }],
    publicTerms: ["applying for housing"],
  },
  {
    id: "chat-passport",
    input: "My passport number is X12345678 and my question is about local rent limits.",
    privateTerms: [{ text: "X12345678", label: "PASSPORT" }],
    publicTerms: ["local rent limits"],
  },
  {
    id: "chat-drivers-license",
    input: "The form asks for my driver's license D1234567, but I only want rent guidance.",
    privateTerms: [{ text: "D1234567", label: "DRIVERS_LICENSE" }],
    publicTerms: ["rent guidance"],
  },
  {
    id: "chat-age-kept",
    input: "I am 63 and my mother who lives with us is 81 years old.",
    privateTerms: [],
    publicTerms: ["63", "81 years old"],
  },
  {
    id: "chat-income-words-kept",
    input: "I bring home about forty thousand dollars annually.",
    privateTerms: [],
    publicTerms: ["forty thousand dollars"],
  },
  {
    id: "chat-low-income-kept",
    input: "My annual income is $18,200 and I live in Newark NJ.",
    privateTerms: [],
    publicTerms: ["$18,200", "Newark NJ"],
  },
  {
    id: "chat-url-private",
    input: "My uploaded documents are at https://files.example.com/private/alex.",
    privateTerms: [{ text: "https://files.example.com/private/alex.", label: "URL" }],
    publicTerms: ["uploaded documents"],
  },
  {
    id: "chat-ip-private",
    input: "The support form recorded IP 192.168.0.14 with my application.",
    privateTerms: [{ text: "192.168.0.14", label: "IP_ADDRESS" }],
    publicTerms: ["support form"],
  },
  {
    id: "chat-email-unusual-tld",
    input: "Contact dr.okeke@clinic.health about the tenant records.",
    privateTerms: [{ text: "dr.okeke@clinic.health", label: "EMAIL" }],
    publicTerms: ["tenant records"],
  },
  {
    id: "chat-phone-dots",
    input: "Reach me on 312.555.7741 after five.",
    privateTerms: [{ text: "312.555.7741", label: "PHONE" }],
    publicTerms: ["after five"],
  },
  {
    id: "chat-phone-bare",
    input: "My phone is 2025550188 and I need a callback.",
    privateTerms: [{ text: "2025550188", label: "PHONE" }],
    publicTerms: ["callback"],
  },
  {
    id: "chat-ssn-spaces",
    input: "My social is 472 81 0094.",
    privateTerms: [{ text: "472 81 0094", label: "SSN" }],
    publicTerms: [],
  },
  {
    id: "chat-ssn-dots",
    input: "SSN: 601.23.7788 for the household head.",
    privateTerms: [{ text: "601.23.7788", label: "SSN" }],
    publicTerms: ["household head"],
  },
  {
    id: "chat-invalid-ssn-kept",
    input: "The order confirmation is 000-12-3456, not a social security number.",
    privateTerms: [],
    publicTerms: ["000-12-3456", "order confirmation"],
  },
  {
    id: "chat-order-number-kept",
    input: "My order confirmation is 482910337 and it shipped yesterday.",
    privateTerms: [],
    publicTerms: ["shipped yesterday"],
  },
  {
    id: "chat-card-no-spaces",
    input: "The card on file is 5500005555555559.",
    privateTerms: [{ text: "5500005555555559", label: "CREDIT_CARD" }],
    publicTerms: [],
  },
  {
    id: "chat-invalid-card-kept",
    input: "The reference number is 4111111111111112 for the document.",
    privateTerms: [],
    publicTerms: ["4111111111111112", "document"],
  },
  {
    id: "chat-street-apartment",
    input: "Send mail to 4417 Westmoreland Blvd Apt 12C, the unit is accessible.",
    privateTerms: [
      { text: "4417", label: "BUILDING_NUMBER" },
      { text: "Westmoreland Blvd", label: "STREET_NAME" },
    ],
    publicTerms: ["unit is accessible"],
  },
  {
    id: "chat-street-court-state-collision",
    input: "I live at 14 Maple Court Hartford CT 06103.",
    privateTerms: [
      { text: "14", label: "BUILDING_NUMBER" },
      { text: "Maple Court", label: "STREET_NAME" },
    ],
    publicTerms: ["Hartford", "CT", "06103"],
  },
  {
    id: "chat-city-state-zip-kept",
    input: "My mailing city is Hartford CT 06103.",
    privateTerms: [],
    publicTerms: ["Hartford", "CT", "06103"],
  },
  {
    id: "chat-household-members",
    input: "My children are Ana Rivera and Mateo Rivera, ages 5 and 9.",
    privateTerms: [
      { text: "Ana", label: "GIVEN_NAME" },
      { text: "Rivera", label: "SURNAME" },
      { text: "Mateo", label: "GIVEN_NAME" },
      { text: "Rivera", label: "SURNAME" },
    ],
    publicTerms: ["ages 5 and 9"],
  },
  {
    id: "chat-two-emails",
    input: "Use maya@example.com first, then backup maya.backup@example.org.",
    privateTerms: [
      { text: "maya@example.com", label: "EMAIL" },
      { text: "maya.backup@example.org", label: "EMAIL" },
    ],
    publicTerms: ["backup"],
  },
  {
    id: "chat-bank-account",
    input: "My bank account number is 123456789012 and my rent is due Friday.",
    privateTerms: [{ text: "123456789012", label: "BANK_ACCOUNT" }],
    publicTerms: ["rent is due Friday"],
  },
  {
    id: "chat-card-hyphenated",
    input: "The payment card field shows 4111-1111-1111-1111.",
    privateTerms: [{ text: "4111-1111-1111-1111", label: "CREDIT_CARD" }],
    publicTerms: ["payment card field"],
  },
  {
    id: "chat-email-plus-subdomain",
    input: "Use alex+housing@sub.example.gov for the intake receipt.",
    privateTerms: [{ text: "alex+housing@sub.example.gov", label: "EMAIL" }],
    publicTerms: ["intake receipt"],
  },
  {
    id: "chat-www-url",
    input: "The uploaded packet is at www.example.org/private/maya.",
    privateTerms: [{ text: "www.example.org/private/maya.", label: "URL" }],
    publicTerms: ["uploaded packet"],
  },
  {
    id: "chat-po-box-dotted",
    input: "Please send notices to P.O. Box 88, Salem OR 97301.",
    privateTerms: [{ text: "P.O. Box 88", label: "STREET_NAME" }],
    publicTerms: ["Salem OR 97301"],
  },
  {
    id: "chat-rural-route-abbrev",
    input: "The mailing line is RR 2 in Taos NM 87571.",
    privateTerms: [{ text: "RR 2", label: "STREET_NAME" }],
    publicTerms: ["Taos NM 87571"],
  },
  {
    id: "chat-account-number-context",
    input: "The account number is 987654321098 for the benefits deposit.",
    privateTerms: [{ text: "987654321098", label: "BANK_ACCOUNT" }],
    publicTerms: ["benefits deposit"],
  },
  {
    id: "chat-public-statute-control",
    input: "Section 42 U.S.C. 1437f covers the voucher program.",
    privateTerms: [],
    publicTerms: ["42 U.S.C. 1437f", "voucher program"],
  },
  {
    id: "chat-public-form-year-control",
    input: "Use Form GOV-9886 for the 2026 recertification packet.",
    privateTerms: [],
    publicTerms: ["Form GOV-9886", "2026", "recertification packet"],
  },
  {
    id: "chat-no-pii-weather",
    input: "The weather is clear today and housing applications are due next month.",
    privateTerms: [],
    publicTerms: ["weather", "housing applications"],
  },
  {
    id: "chat-no-pii-form-number",
    input: "Form 8823 is due in 2026 and covers buildings over 50 units.",
    privateTerms: [],
    publicTerms: ["Form 8823", "2026", "50 units"],
  },
  {
    id: "chat-location-public",
    input: "I live in Placentia, California and make $38,500 a year.",
    privateTerms: [],
    publicTerms: ["Placentia, California", "$38,500"],
  },
  {
    id: "chat-mixed-dense",
    input:
      "I'm Priyanka Venkataraman, email pv.ranga@fastmail.io, cell 646-555-0199, " +
      "SSN 533-22-1847, living at 88 Larkspur Lane, age 29, income $52,000.",
    privateTerms: [
      { text: "Priyanka Venkataraman", label: "GIVEN_NAME" },
      { text: "pv.ranga@fastmail.io", label: "EMAIL" },
      { text: "646-555-0199", label: "PHONE" },
      { text: "533-22-1847", label: "SSN" },
      { text: "88 Larkspur Lane", label: "STREET_NAME" },
    ],
    publicTerms: ["age 29", "$52,000"],
  },
  {
    id: "chat-accented-name-address",
    input: "My name is Renée Müller and I live at 1234 Cárdenas Boulevard.",
    privateTerms: [
      { text: "Renée", label: "GIVEN_NAME" },
      { text: "Müller", label: "SURNAME" },
      { text: "1234", label: "BUILDING_NUMBER" },
      { text: "Cárdenas Boulevard", label: "STREET_NAME" },
    ],
    publicTerms: [],
  },
  {
    id: "chat-accented-name-phone",
    input: "Please contact José Ångström at 305-201-0143 about the appointment.",
    privateTerms: [
      { text: "José", label: "GIVEN_NAME" },
      { text: "Ångström", label: "SURNAME" },
      { text: "305-201-0143", label: "PHONE" },
    ],
    publicTerms: ["appointment"],
  },
  {
    id: "chat-duplicate-digit-run-address",
    input: "Call me at 646-555-0199. I live at 1234 Maple Street.",
    privateTerms: [
      { text: "646-555-0199", label: "PHONE" },
      { text: "1234", label: "BUILDING_NUMBER" },
      { text: "Maple Street", label: "STREET_NAME" },
    ],
    publicTerms: [],
  },
];
