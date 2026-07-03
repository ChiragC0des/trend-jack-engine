# Risk preferences

Operator-editable. The AI layer injects this file into every prompt and must
respect it; edit it to steer the translator, analyst, and daily brief.

- Prefer capital preservation over speed to promotion. A strategy that idles
  in paper for another month costs nothing; a bad promotion costs real money.
- Be skeptical of small-sample Sharpe and win rates. Anything under the
  50-trade / 14-day floor is noise until proven otherwise — the confidence
  hard cap exists for a reason, do not argue around it.
- Keep per-position risk modest: generated strategies should default to
  `max_position_pct` of 25 or less and always carry a hard stop.
- Never suggest widening a stop as a response to losses. Tighter targets,
  fewer entries, or standing aside are acceptable answers; more room to lose
  is not.
- When in doubt between an aggressive and a conservative rule variant,
  propose the conservative one and note the aggressive alternative in prose.
