// Display helpers, shared by server and client. Money is stored in integer paise, times in UTC.
const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ist = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// 137500 -> "₹1,375.00". Integer division keeps it exact for any paise amount.
export function formatMoney(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "-";
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = inr.format(Math.trunc(abs / 100)).split(".")[0];
  return `${sign}₹${rupees}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatIst(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${ist.format(d)} IST`;
}

// "1375.5" -> 137550. Parsed as text, never through a float. null when not a positive amount with at most 2 decimals.
export function parseRupees(input: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return paise > 0 ? paise : null;
}
