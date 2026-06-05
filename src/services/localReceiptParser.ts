export type LocalReceiptParserResult = {
  isPaymentReceipt: boolean;
  amount: number | null;
  currency: "RUB" | "EGP" | null;
  date: string | null;
  status: "success" | "unknown" | "failed";
  confidence: number;
  parser: "local";
  reason: string;
  rawSnippet?: string;
};

const amountLabels = [
  "Сумма перевода",
  "Сумма операции",
  "Сумма",
  "Итого",
  "К оплате",
  "Перевод",
];

const positiveKeywords = [
  "чек",
  "квитанция",
  "перевод",
  "операция",
  "сумма",
  "получатель",
  "отправитель",
  "банк",
];

const studyMaterialKeywords = [
  "учебник",
  "урок",
  "упражнение",
  "страница",
  "глава",
  "audio",
  "listening",
  "الوحدة",
  "كتاب",
];

const successPatterns = [
  /выполнено/i,
  /успешно/i,
  /исполнено/i,
  /операция\s+выполнена/i,
  /плат[её]ж\s+выполнен/i,
  /перевод\s+выполнен/i,
];

const failedPatterns = [
  /отменено/i,
  /отклонено/i,
  /не\s+выполнено/i,
  /ошибка/i,
  /возврат/i,
];

const monthNames: Record<string, string> = {
  января: "01",
  февраль: "02",
  февраля: "02",
  март: "03",
  марта: "03",
  апрель: "04",
  апреля: "04",
  май: "05",
  мая: "05",
  июнь: "06",
  июня: "06",
  июль: "07",
  июля: "07",
  август: "08",
  августа: "08",
  сентябрь: "09",
  сентября: "09",
  октябрь: "10",
  октября: "10",
  ноябрь: "11",
  ноября: "11",
  декабрь: "12",
  декабря: "12",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCurrencyText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/₽/gi, " RUB ")
    .replace(/\bруб\.?\b/gi, " RUB ")
    .replace(/\bр\.\b/gi, " RUB ")
    .replace(/\bRUB\b/gi, " RUB ");
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLocaleLowerCase("ru-RU").includes(keyword.toLocaleLowerCase("ru-RU"));
}

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.filter((keyword) => includesKeyword(text, keyword)).length;
}

function parseAmountValue(value: string): number | null {
  const compact = value.replace(/\s+/g, "");
  const hasComma = compact.includes(",");
  const hasDot = compact.includes(".");
  let normalized = compact;

  if (hasComma && hasDot) {
    const commaIndex = compact.lastIndexOf(",");
    const dotIndex = compact.lastIndexOf(".");
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = compact
      .replace(new RegExp(`\\${thousandsSeparator}`, "g"), "")
      .replace(decimalSeparator, ".");
  } else if (hasComma) {
    const [, fraction = ""] = compact.split(",");
    normalized =
      fraction.length === 3 && compact.indexOf(",") <= 3
        ? compact.replace(/,/g, "")
        : compact.replace(",", ".");
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function amountRegex(): RegExp {
  const amountPattern =
    String.raw`(?:\d{1,3}(?:[ \u00a0]\d{3})+(?:[,.]\d{2})?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:[,.]\d{2})?|\d+)`;
  const currencyPattern = String.raw`(?:RUB|EGP|руб\.?|р\.?|₽|جنيه)`;
  return new RegExp(
    String.raw`(?:${currencyPattern}\s*)?(${amountPattern})(?:\s*${currencyPattern})?`,
    "i"
  );
}

function extractAmount(text: string): number | null {
  const normalized = normalizeCurrencyText(text);

  for (const label of amountLabels) {
    const labelIndex = normalized.toLocaleLowerCase("ru-RU").indexOf(
      label.toLocaleLowerCase("ru-RU")
    );
    if (labelIndex === -1) {
      continue;
    }

    const afterLabel = normalized.slice(labelIndex + label.length, labelIndex + label.length + 90);
    const match = afterLabel.match(amountRegex());
    const amount = match?.[1] ? parseAmountValue(match[1]) : null;
    if (amount !== null) {
      return amount;
    }
  }

  const withCurrency = normalized.match(
    /(?:RUB|EGP|руб\.?|р\.?|₽|جنيه)\s*(\d[\d\s\u00a0,.]*)|(\d[\d\s\u00a0,.]*)\s*(?:RUB|EGP|руб\.?|р\.?|₽|جنيه)/i
  );
  return parseAmountValue(withCurrency?.[1] ?? withCurrency?.[2] ?? "");
}

function detectCurrency(text: string): "RUB" | "EGP" | null {
  if (/(₽|\bRUB\b|\bруб\.?\b|\bр\.\b)/i.test(text)) {
    return "RUB";
  }

  if (/\bEGP\b|جنيه/i.test(text)) {
    return "EGP";
  }

  return null;
}

function detectStatus(text: string): LocalReceiptParserResult["status"] {
  if (failedPatterns.some((pattern) => pattern.test(text))) {
    return "failed";
  }

  if (successPatterns.some((pattern) => pattern.test(text))) {
    return "success";
  }

  return "unknown";
}

function toIsoDate(year: string, month: string, day: string): string | null {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);
  if (yyyy < 2000 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return null;
  }

  return `${yyyy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd
    .toString()
    .padStart(2, "0")}`;
}

function extractDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return toIsoDate(iso[1], iso[2], iso[3]);
  }

  const numeric = text.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/);
  if (numeric) {
    return toIsoDate(numeric[3], numeric[2], numeric[1]);
  }

  const monthName = text.match(
    /\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})\b/i
  );
  if (monthName) {
    const month = monthNames[monthName[2].toLocaleLowerCase("ru-RU")];
    return month ? toIsoDate(monthName[3], month, monthName[1]) : null;
  }

  return null;
}

function buildConfidence(input: {
  isPaymentReceipt: boolean;
  receiptKeywordHits: number;
  amount: number | null;
  currency: "RUB" | "EGP" | null;
  status: LocalReceiptParserResult["status"];
  looksLikeStudyMaterial: boolean;
}): number {
  if (input.looksLikeStudyMaterial) {
    return 0.96;
  }

  if (!input.isPaymentReceipt || input.amount === null) {
    return input.receiptKeywordHits > 0 ? 0.45 : 0.25;
  }

  if (input.status === "success" && input.currency !== null && input.receiptKeywordHits > 0) {
    return 0.94;
  }

  if (input.receiptKeywordHits > 0 && input.status === "unknown") {
    return input.currency ? 0.78 : 0.68;
  }

  if (input.status === "failed" && input.currency !== null) {
    return 0.9;
  }

  return 0.55;
}

export function parseLocalReceiptText(
  rawText: string,
  filename?: string
): LocalReceiptParserResult {
  const sourceText = normalizeWhitespace(`${filename ? `${filename} ` : ""}${rawText}`);
  const normalizedText = normalizeCurrencyText(sourceText);
  const receiptKeywordHits = countKeywordHits(normalizedText, positiveKeywords);
  const studyMaterialHits = countKeywordHits(normalizedText, studyMaterialKeywords);
  const amount = extractAmount(normalizedText);
  const currency = detectCurrency(sourceText);
  const status = detectStatus(normalizedText);
  const date = extractDate(normalizedText);
  const looksLikeStudyMaterial =
    studyMaterialHits >= 2 && (receiptKeywordHits === 0 || (amount === null && status === "unknown"));

  if (looksLikeStudyMaterial) {
    return {
      isPaymentReceipt: false,
      amount: null,
      currency: null,
      date,
      status: "unknown",
      confidence: 0.96,
      parser: "local",
      reason: "Looks like study material, not a payment receipt",
      rawSnippet: normalizedText.slice(0, 500),
    };
  }

  const isPaymentReceipt = receiptKeywordHits > 0 && (amount !== null || status !== "unknown");
  const confidence = buildConfidence({
    isPaymentReceipt,
    receiptKeywordHits,
    amount,
    currency,
    status,
    looksLikeStudyMaterial,
  });
  const reasonParts = [
    receiptKeywordHits > 0 ? `receipt keywords: ${receiptKeywordHits}` : "no receipt keywords",
    amount !== null ? "amount found" : "amount missing",
    currency ? `currency ${currency}` : "currency missing",
    `status ${status}`,
  ];

  return {
    isPaymentReceipt,
    amount,
    currency,
    date,
    status,
    confidence,
    parser: "local",
    reason: reasonParts.join("; "),
    rawSnippet: normalizedText.slice(0, 500),
  };
}
