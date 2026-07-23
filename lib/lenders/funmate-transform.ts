export type FunmateApplication = {
  externalId: string;
  business: {
    legalName: string;
    dba: string | null;
    industry: string | null;
    state: string | null;
    timeInBusinessMonths: number | null;
  };
  owner: {
    name: string | null;
    email: string | null;
    phone: string | null;
    fico: number | null;
  };
  funding: {
    requestedAmount: number | null;
    monthlyRevenue: number | null;
    averageDailyBalance: number | null;
    existingPositions: number | null;
    desiredProduct: string | null;
  };
  source: "sunbiz";
  transformedAt: string;
};

const text = (...values: unknown[]) => {
  const value = values.find((v) => typeof v === "string" && v.trim());
  return typeof value === "string" ? value.trim() : null;
};
const number = (...values: unknown[]) => {
  const value = values.find((v) => typeof v === "number" && Number.isFinite(v));
  return typeof value === "number" ? value : null;
};

export function transformSunbizApplicationForFunmate(
  applicationId: string,
  data: Record<string, unknown>,
): FunmateApplication {
  const legalName = text(data.business_legal_name, data.legal_name, data.business_name, data.merchant_name);
  if (!legalName) throw new Error("funmate_transform_missing:business_legal_name");
  return {
    externalId: applicationId,
    business: {
      legalName,
      dba: text(data.dba, data.business_name),
      industry: text(data.industry, data.business_industry),
      state: text(data.business_state, data.merchant_state, data.state),
      timeInBusinessMonths: number(data.time_in_business_months),
    },
    owner: {
      name: text(data.owner_name, data.contact_name, data.applicant_name),
      email: text(data.owner_email, data.email),
      phone: text(data.owner_phone, data.phone),
      fico: number(data.applicant_fico, data.fico),
    },
    funding: {
      requestedAmount: number(data.requested_amount, data.amount_requested),
      monthlyRevenue: number(data.monthly_revenue, data.average_monthly_revenue),
      averageDailyBalance: number(data.avg_daily_balance, data.average_daily_balance),
      existingPositions: number(data.position_count, data.existing_positions),
      desiredProduct: text(data.desired_product, data.product_type),
    },
    source: "sunbiz",
    transformedAt: new Date().toISOString(),
  };
}

const money = (value: number | null) =>
  value == null ? "Not provided" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function renderFunmateSubmission(app: FunmateApplication, notes = "") {
  return {
    subject: `FundMate Submission | ${app.business.legalName}`,
    text: [
      "New application routed through the FundMate lender network.",
      "",
      `Business: ${app.business.legalName}`,
      `DBA: ${app.business.dba || "Not provided"}`,
      `Industry: ${app.business.industry || "Not provided"}`,
      `State: ${app.business.state || "Not provided"}`,
      `Time in business: ${app.business.timeInBusinessMonths ?? "Not provided"} months`,
      `Requested: ${money(app.funding.requestedAmount)}`,
      `Monthly revenue: ${money(app.funding.monthlyRevenue)}`,
      `Average daily balance: ${money(app.funding.averageDailyBalance)}`,
      `Existing positions: ${app.funding.existingPositions ?? "Not provided"}`,
      "",
      notes.trim() ? `Notes: ${notes.trim()}` : "",
      "Application and selected supporting documents are attached.",
      "",
      `SunBiz reference: ${app.externalId}`,
    ].filter(Boolean).join("\n"),
  };
}

