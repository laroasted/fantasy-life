// Fantasy Life Hub — Member constants
// All league members with IDs, display names, and full names

export const DRAFT_MEMBERS = [
  { id: "adam", name: "Adam", full: "Adam Elhadad" },
  { id: "dhruv", name: "Dhruv", full: "Dhruv Desai" },
  { id: "marsh", name: "Marsh", full: "Austin Marshall" },
  { id: "jordan", name: "Jordan", full: "Jordan Duffey" },
  { id: "alan", name: "Alan", full: "Alan Awrabi" },
  { id: "evan", name: "Evan", full: "Evan Goronkin" },
  { id: "larosa", name: "LaRosa", full: "Michael Larosa" },
  { id: "jack", name: "Jack", full: "John Jack Kurzava" },
  { id: "mike", name: "Mike", full: "Michael Short" },
  { id: "danny", name: "Danny", full: "Daniel Strockis" },
  { id: "auzy", name: "Auzy", full: "Austin Freed" },
];

// Member identity colors — generated, not copied from a framework's default
// ramp. The original list here was Tailwind's default palette's 500-weight
// stops in their canonical order (red/orange/yellow/green/teal/cyan/blue/
// indigo/violet/fuchsia/rose) — i.e. nobody actually chose these, someone
// walked a reference chart left to right. This set instead comes from one
// explicit formula, computed once and hardcoded (see
// scripts/gen-member-colors.js if that's ever rerun): HSL with fixed
// saturation 72% / lightness 56% (tuned for legibility on theme.bg
// "#0B0E14"), hue stepped at 360/11 ≈ 32.7° starting at 16.5° — a start
// offset chosen to maximize distance from this app's own semantic hues
// (theme.yel/grn/up/down/you/acc) so a member's name color is never
// mistaken for a win/loss/lock/"you" cue elsewhere on the same screen.
export const MEMBER_COLORS = {
  adam: "#e06c3e",   // hue 17
  dhruv: "#e0c23e",  // hue 49
  marsh: "#a4e03e",  // hue 82
  jordan: "#4be03e", // hue 115
  alan: "#3ee087",   // hue 147
  evan: "#3ee0e0",   // hue 180
  larosa: "#3e87e0", // hue 213
  jack: "#4e3ee0",   // hue 246
  mike: "#a43ee0",   // hue 278
  danny: "#e03ec2",  // hue 311
  auzy: "#e03e69",   // hue 344
};

// Colors assigned to new members added during draft setup — same formula as
// MEMBER_COLORS above, hues offset by half a step (16.5 deg) so a newly
// added member never lands on an existing one's exact color.
export const NEW_MEMBER_COLORS = [
  "#e0973e", // hue 33
  "#cfe03e", // hue 66
  "#79e03e", // hue 98
  "#3ee05c", // hue 131
  "#3ee0b4", // hue 164
  "#3eb2e0", // hue 197
  "#3e5ce0", // hue 229
  "#793ee0", // hue 262
];