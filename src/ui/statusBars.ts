export interface StatusBarState {
  flying: boolean;
  rad01: number;
  shield01: number;
  shieldBroken: boolean;
  flashAt: number;
}

export function createStatusBars(): { el: HTMLElement; sync(s: StatusBarState): void } {
  const root = document.createElement("div");
  root.className = "sb-root";

  function makeBar(kind: "rad" | "shield", label: string): { bar: HTMLElement; fill: HTMLElement } {
    const bar = document.createElement("div");
    bar.className = "sb-bar sb-" + kind;

    const lbl = document.createElement("span");
    lbl.className = "sb-label";
    lbl.textContent = label;

    const track = document.createElement("div");
    track.className = "sb-track";

    const fill = document.createElement("div");
    fill.className = "sb-fill";
    track.appendChild(fill);

    bar.appendChild(lbl);
    bar.appendChild(track);
    return { bar, fill };
  }

  const rad = makeBar("rad", "RADIATION");
  const shield = makeBar("shield", "SHIELD");
  root.appendChild(rad.bar);
  root.appendChild(shield.bar);

  let lastFlying: boolean | null = null;
  let lastRadPct = -1;
  let lastShieldPct = -1;
  let lastBroken: boolean | null = null;
  let lastFlashAt = -1;
  let lastRadColor = "";
  let flashTimer: number | null = null;

  function triggerFlash() {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    rad.bar.classList.remove("sb-flash");
    void rad.bar.offsetWidth;
    rad.bar.classList.add("sb-flash");
    flashTimer = window.setTimeout(() => {
      rad.bar.classList.remove("sb-flash");
      flashTimer = null;
    }, 350);
  }

  function sync(s: StatusBarState) {
    if (lastFlying !== s.flying) {
      shield.bar.style.display = s.flying ? "" : "none";
      lastFlying = s.flying;
    }
    const radPct = Math.round(s.rad01 * 100);
    if (radPct !== lastRadPct) {
      rad.fill.style.width = radPct + "%";
      lastRadPct = radPct;
    }
    const radColor = "rgb(" + Math.round(80 + 175 * s.rad01) + ", " + Math.round(220 - 180 * s.rad01) + ", " + Math.round(120 - 100 * s.rad01) + ")";
    if (radColor !== lastRadColor) {
      rad.fill.style.background = radColor;
      lastRadColor = radColor;
    }
    const shieldPct = Math.round(s.shield01 * 100);
    if (shieldPct !== lastShieldPct) {
      shield.fill.style.width = shieldPct + "%";
      lastShieldPct = shieldPct;
    }
    if (lastBroken !== s.shieldBroken) {
      shield.bar.classList.toggle("sb-broken", s.shieldBroken);
      lastBroken = s.shieldBroken;
    }
    if (s.flashAt !== -1 && s.flashAt !== lastFlashAt) {
      lastFlashAt = s.flashAt;
      triggerFlash();
    } else {
      lastFlashAt = s.flashAt;
    }
  }

  return { el: root, sync };
}