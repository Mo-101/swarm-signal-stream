# Hold v3, compare at 20 closes

No code changes. The engine stays exactly as it is: `STRATEGY_EPOCH = "v3"`, wide vol stops (150-450 bps, 3.5x), 2:1 reward, breakeven at +1.5R, trailing from +2.5R, passive maker entry and symbol cost gating on. No revert to v1, no replica shadow book, no config edits.

## What happens next

1. v3 keeps trading paper until it reaches **20 closed trades** (currently 7).
2. At that point I run the three-way comparison across v1 / v2 / v3 on the same metrics: net realized USD, win rate, average win vs average loss, expectancy per trade, and round-trip execution cost in bps — plus a Wilson interval on each win rate so we can see how much of the gap is still noise.
3. Only then do we decide whether the geometry changes. If v3 clears v1 on expectancy, it stays and we stop iterating. If it does not, the comparison tells us which component to attack rather than guessing.

## Note on the sample

20 closes is enough to see direction, not enough to be conclusive on win rate alone — at n=20 a 30% win rate and a 45% win rate are statistically indistinguishable. Expectancy and execution cost per trade converge faster than win rate, so those carry the weight in the read. I will flag explicitly which conclusions the sample actually supports.

## Open items unrelated to this decision

- Bybit testnet key returns HTTP 401, so the execution health probe stays degraded. Paper trading is unaffected; this only needs fixing before any live capital.
- The deployed VPS image is still running v2 geometry. A GitHub sync would let CI build a v3 image.
