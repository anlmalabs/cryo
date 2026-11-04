export interface RadiationInputs { flying: boolean; piercing: boolean; }
export interface RadiationEvents {
  onShieldHit(hpLost: number, shield01: number): void;
  onShieldBroken(): void;
  onRadFlash(rad01: number): void;
  onDeath(): void;
}

export class RadiationSystem {
  private events: RadiationEvents;
  private shieldMaxHP = 2000;
  private drainPerFlash = 40;
  private radPerFlash = 1 / 20;
  private _shieldHP = 2000;
  private rad = 0;
  private _shieldBroken = false;
  private dead = false;
  private _flashes = 0;
  private prevPiercing = false;

  constructor(events: RadiationEvents) { this.events = events; }

  setShield(maxHP: number, drainPerFlash: number): void {
    this.shieldMaxHP = maxHP;
    this.drainPerFlash = drainPerFlash;
    this._shieldHP = maxHP;
    this._shieldBroken = false;
  }
  setRadBudget(flashesToDeath: number): void {
    this.radPerFlash = 1 / flashesToDeath;
  }
  get shield01(): number { return this.shieldMaxHP > 0 ? this._shieldHP / this.shieldMaxHP : 0; }
  get shieldHP(): number { return this._shieldHP; }
  get rad01(): number { return this.rad; }
  get shieldBroken(): boolean { return this._shieldBroken; }
  get flashes(): number { return this._flashes; }

  update(_dt: number, inputs: RadiationInputs): void {
    const rising = inputs.piercing && !this.prevPiercing;
    this.prevPiercing = inputs.piercing;
    if (!rising) return;
    if (this.dead) return;
    this._flashes++;
    if (inputs.flying) {
      if (!this._shieldBroken) {
        this._shieldHP -= this.drainPerFlash;
        if (this._shieldHP < 0) this._shieldHP = 0;
        this.events.onShieldHit(this.drainPerFlash, this.shield01);
        if (this._shieldHP === 0) {
          this._shieldBroken = true;
          this.events.onShieldBroken();
        }
      } else {
        this.rad += this.radPerFlash;
        if (this.rad > 1) this.rad = 1;
        if (this.rad >= 1 - 1e-9) this.rad = 1;
        this.events.onRadFlash(this.rad);
        if (this.rad >= 1) { this.dead = true; this.events.onDeath(); }
      }
    } else {
      this.rad += this.radPerFlash;
      if (this.rad > 1) this.rad = 1;
      if (this.rad >= 1 - 1e-9) this.rad = 1;
      this.events.onRadFlash(this.rad);
      if (this.rad >= 1) { this.dead = true; this.events.onDeath(); }
    }
  }

  reset(): void {
    this._shieldHP = this.shieldMaxHP;
    this.rad = 0;
    this._shieldBroken = false;
    this.dead = false;
    this._flashes = 0;
    this.prevPiercing = false;
  }
}
