// Decay watch: parole for a convicted hypothesis.
//
// A one-sided CUSUM compares each new trade (net bps) with the tested mean and
// accumulates evidence that the edge has dropped toward zero. The alarm
// threshold is CALIBRATED from the hypothesis's own tested trades: replaying
// bootstrapped copies of them, it is set so that a signal performing exactly as
// tested is wrongly retired within `horizonTrades` trades no more than
// `falseAlarm` of the time.
import { mulberry32 } from "./court";

export type DecayStatus = "ACTIVE" | "WATCH" | "RETIRED";

export class DecayWatch {
  s = 0;
  n = 0;
  status: DecayStatus = "ACTIVE";
  retiredAt = -1;

  constructor(
    readonly testedMean: number,
    readonly testedSd: number,
    readonly h: number,
    readonly minTrades = 10,
  ) {}

  static calibrated(
    tested: number[],
    horizonTrades = 100,
    falseAlarm = 0.05,
    paths = 4000,
    seed = 0,
  ): DecayWatch {
    const rng = mulberry32(seed);
    const m = tested.reduce((a, b) => a + b, 0) / tested.length;
    const sd = Math.sqrt(tested.reduce((a, b) => a + (b - m) ** 2, 0) / (tested.length - 1));
    const k = m / 2;
    const peaks: number[] = [];
    for (let p = 0; p < paths; p++) {
      let s = 0;
      let peak = 0;
      for (let j = 0; j < horizonTrades; j++) {
        const x = tested[Math.floor(rng() * tested.length)];
        s = Math.max(0, s + (k - x) / sd);
        if (s > peak) peak = s;
      }
      peaks.push(peak);
    }
    peaks.sort((a, b) => a - b);
    return new DecayWatch(m, sd, peaks[Math.floor((1 - falseAlarm) * (paths - 1))]);
  }

  update(netBps: number): DecayStatus {
    if (this.status === "RETIRED") return this.status;
    this.n++;
    this.s = Math.max(0, this.s + (this.testedMean / 2 - netBps) / this.testedSd);
    if (this.n >= this.minTrades && this.s > this.h) {
      this.status = "RETIRED";
      this.retiredAt = this.n;
    } else {
      this.status = this.s > this.h / 2 ? "WATCH" : "ACTIVE";
    }
    return this.status;
  }
}
