/**
 * MIT License
 *
 * Original Slim slice of the public Moment.js call-site surface: ISO parse,
 * format tokens (YYYY MM DD HH mm ss SSS M D H m s A a), unix/valueOf/toDate,
 * add/subtract for days/months/years/hours/minutes/seconds, isValid.
 * Local timezone. No locales, no moment-timezone, no plugins.
 * Not affiliated with Moment.js authors.
 */
const TOKEN = /YYYY|SSS|MM|DD|HH|mm|ss|A|a|M|D|H|m|s/g;
const UNIT_ALIAS = {
    year: "years",
    years: "years",
    y: "years",
    month: "months",
    months: "months",
    M: "months",
    day: "days",
    days: "days",
    d: "days",
    hour: "hours",
    hours: "hours",
    h: "hours",
    minute: "minutes",
    minutes: "minutes",
    m: "minutes",
    second: "seconds",
    seconds: "seconds",
    s: "seconds",
};
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function pad(n, width) {
    const s = String(Math.abs(n));
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
}
function lastDayOfMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}
function parseIso(str) {
    const trimmed = str.trim();
    const m = ISO.exec(trimmed);
    if (!m) {
        const fallback = Date.parse(trimmed);
        return new Date(fallback);
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = m[4] === undefined ? 0 : Number(m[4]);
    const minute = m[5] === undefined ? 0 : Number(m[5]);
    const second = m[6] === undefined ? 0 : Number(m[6]);
    const frac = m[7] ?? "0";
    const ms = Number((frac + "000").slice(0, 3));
    const offset = m[8];
    const dateOnly = m[4] === undefined;
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return new Date(NaN);
    if (hour > 23 || minute > 59 || second > 59)
        return new Date(NaN);
    if (dateOnly) {
        const local = new Date(year, month - 1, day);
        if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
            return new Date(NaN);
        }
        return local;
    }
    if (offset === undefined) {
        const local = new Date(year, month - 1, day, hour, minute, second, ms);
        if (local.getFullYear() !== year ||
            local.getMonth() !== month - 1 ||
            local.getDate() !== day) {
            return new Date(NaN);
        }
        return local;
    }
    let offsetMin = 0;
    if (offset !== "Z") {
        const sign = offset[0] === "-" ? -1 : 1;
        const digits = offset.slice(1).replace(":", "");
        const oh = Number(digits.slice(0, 2));
        const om = Number(digits.slice(2) || "0");
        offsetMin = sign * (oh * 60 + om);
    }
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000;
    return new Date(utcMs);
}
function parseInput(input) {
    if (input === undefined)
        return new Date(Date.now());
    if (input === null)
        return new Date(NaN);
    if (input instanceof Date)
        return new Date(input.getTime());
    if (typeof input === "number")
        return new Date(input);
    if (typeof input === "boolean" || typeof input === "function")
        return new Date(NaN);
    if (typeof input === "string") {
        if (input.trim() === "")
            return new Date(NaN);
        return parseIso(input);
    }
    if (typeof input === "object")
        return new Date(Date.now());
    return new Date(NaN);
}
function tokenValue(date, tok) {
    switch (tok) {
        case "YYYY":
            return pad(date.getFullYear(), 4);
        case "MM":
            return pad(date.getMonth() + 1, 2);
        case "M":
            return String(date.getMonth() + 1);
        case "DD":
            return pad(date.getDate(), 2);
        case "D":
            return String(date.getDate());
        case "HH":
            return pad(date.getHours(), 2);
        case "H":
            return String(date.getHours());
        case "mm":
            return pad(date.getMinutes(), 2);
        case "m":
            return String(date.getMinutes());
        case "ss":
            return pad(date.getSeconds(), 2);
        case "s":
            return String(date.getSeconds());
        case "SSS":
            return pad(date.getMilliseconds(), 3);
        case "A":
            return date.getHours() < 12 ? "AM" : "PM";
        case "a":
            return date.getHours() < 12 ? "am" : "pm";
        default:
            return tok;
    }
}
function formatOffset(date) {
    const min = -date.getTimezoneOffset();
    const sign = min >= 0 ? "+" : "-";
    const abs = Math.abs(min);
    return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}
function applyUnit(date, n, unit) {
    const kind = UNIT_ALIAS[unit] ?? UNIT_ALIAS[unit.toLowerCase()];
    if (!kind || n === 0)
        return;
    switch (kind) {
        case "years": {
            const day = date.getDate();
            date.setDate(1);
            date.setFullYear(date.getFullYear() + n);
            date.setDate(Math.min(day, lastDayOfMonth(date.getFullYear(), date.getMonth())));
            break;
        }
        case "months": {
            const day = date.getDate();
            date.setDate(1);
            date.setMonth(date.getMonth() + n);
            date.setDate(Math.min(day, lastDayOfMonth(date.getFullYear(), date.getMonth())));
            break;
        }
        case "days":
            date.setDate(date.getDate() + n);
            break;
        case "hours":
            date.setHours(date.getHours() + n);
            break;
        case "minutes":
            date.setMinutes(date.getMinutes() + n);
            break;
        case "seconds":
            date.setSeconds(date.getSeconds() + n);
            break;
        default:
            break;
    }
}
class SlimMoment {
    date;
    constructor(input) {
        this.date = parseInput(input);
    }
    isValid() {
        return !Number.isNaN(this.date.getTime());
    }
    format(pattern) {
        if (!this.isValid())
            return "Invalid date";
        if (pattern === undefined) {
            return `${formatDate(this.date, "YYYY-MM-DDTHH:mm:ss")}${formatOffset(this.date)}`;
        }
        return formatDate(this.date, pattern);
    }
    unix() {
        return Math.floor(this.date.getTime() / 1000);
    }
    valueOf() {
        return this.date.getTime();
    }
    toDate() {
        return new Date(this.date.getTime());
    }
    add(amount, unit) {
        if (!this.isValid())
            return this;
        if (amount !== null && typeof amount === "object") {
            for (const [u, n] of Object.entries(amount)) {
                if (typeof n === "number")
                    applyUnit(this.date, n, u);
            }
            return this;
        }
        if (typeof amount === "number" && unit)
            applyUnit(this.date, amount, unit);
        return this;
    }
    subtract(amount, unit) {
        if (amount !== null && typeof amount === "object") {
            const negated = {};
            for (const [u, n] of Object.entries(amount))
                negated[u] = -n;
            return this.add(negated);
        }
        return this.add(-amount, unit);
    }
}
function formatDate(date, pattern) {
    return pattern.replace(TOKEN, (tok) => tokenValue(date, tok));
}
export function createMoment(input) {
    return new SlimMoment(input);
}
export const moment = createMoment;
export default moment;
//# sourceMappingURL=moment.js.map