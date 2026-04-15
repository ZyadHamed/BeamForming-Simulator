// ══════════════════════════════════════════════════════════════════
//  ProbeArrayComponent
//  Manages N ProbeElements:
//    • Add / remove elements
//    • Geometry editor (linear / curved) with spacing & curvature
//    • Collective steering angle + focus depth sliders
//    • 2D geometry canvas showing element positions + combined beam
//    • Delegates FFT/IFFT to BeamformingService
// ══════════════════════════════════════════════════════════════════

import {
  Component, Input, Output, EventEmitter,
  OnInit, OnChanges, OnDestroy, SimpleChanges,
  ViewChild, ElementRef, ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';

import { ProbeElementComponent } from '../probe-element/probe-element.component';
import { BeamformingService }    from '../../services/beamforming.service';
import {
  ArrayConfig, ProbeElementConfig,
  ArrayGeometry, makeDefaultElement, makeDefaultArrayConfig,
  BeamformingResult,
} from '../../models/beamforming.models';

@Component({
  selector       : 'app-probe-array',
  standalone     : true,
  imports        : [CommonModule, FormsModule, ProbeElementComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './probe-array.component.html',
  styleUrls      : ['./probe-array.component.css'],
})
export class ProbeArrayComponent implements OnInit, OnChanges, OnDestroy {

  @Input()  arrayConfig!   : ArrayConfig;
  @Input()  label          : string = 'Probe Array';
  @Input()  showBeamResult : boolean = true;
  @Output() configChange   = new EventEmitter<ArrayConfig>();
  @Output() beamResult     = new EventEmitter<BeamformingResult>();

  @ViewChild('geometryCanvas', { static: true })
  geoCanvasRef!: ElementRef<HTMLCanvasElement>;

  selectedElementId : string | null = null;
  beamformResult    : BeamformingResult | null = null;
  computing         : boolean = false;
  panelTab          : 'elements' | 'geometry' | 'beam' = 'elements';

  private animFrameId: number = 0;
  private beamPhase  : number = 0;
  private destroy$   = new Subject<void>();

  constructor(
    private beamformSvc: BeamformingService,
    private cdr        : ChangeDetectorRef,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────

  ngOnInit(): void {
    if (!this.arrayConfig) this.arrayConfig = makeDefaultArrayConfig(4);
    this.startAnimation();
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['arrayConfig'] && !ch['arrayConfig'].firstChange) {
      this.redrawGeometry();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Derived helpers ───────────────────────────────────────────

  get elements(): ProbeElementConfig[] {
    return this.arrayConfig?.elements ?? [];
  }

  get selectedElement(): ProbeElementConfig | null {
    return this.elements.find(e => e.id === this.selectedElementId) ?? null;
  }

  // ── Element management ────────────────────────────────────────

  addElement(): void {
    const idx = this.elements.length;
    const newEl = makeDefaultElement(idx);
    this.arrayConfig = {
      ...this.arrayConfig,
      numElements: this.arrayConfig.numElements + 1,
      elements   : [...this.elements, newEl],
    };
    this.recalcApodizationWeights();
    this.emit();
  }

  removeElement(id: string): void {
    if (this.elements.length <= 1) return;
    const elements = this.elements.filter(e => e.id !== id);
    this.arrayConfig = {
      ...this.arrayConfig,
      numElements: elements.length,
      elements,
    };
    if (this.selectedElementId === id) this.selectedElementId = null;
    this.recalcApodizationWeights();
    this.emit();
  }

  onElementConfigChange(updated: ProbeElementConfig): void {
    const elements = this.elements.map(e => e.id === updated.id ? updated : e);
    this.arrayConfig = { ...this.arrayConfig, elements };
    this.emit();
  }

  selectElement(id: string): void {
    this.selectedElementId = this.selectedElementId === id ? null : id;
    this.cdr.markForCheck();
  }

  // ── Collective geometry controls ──────────────────────────────

onGeometryChange(): void {
  this.recalcDelaysForSteering();
  this.recalcApodizationWeights();
  this.emit();
}

  setGeometry(geo: ArrayGeometry): void {
    this.arrayConfig = { ...this.arrayConfig, geometry: geo };
    this.recalcDelaysForSteering();
    this.emit();
  }

  /** Recalculates steering delays for all elements whenever angle changes. */
  private recalcDelaysForSteering(): void {
    this.beamformSvc
      .computeSteeringDelays(this.arrayConfig, this.arrayConfig.steeringAngle)
      .pipe(takeUntil(this.destroy$))
      .subscribe(delays => {
        const elements = this.elements.map((el, i) => ({
          ...el,
          timeDelay: parseFloat((delays[i] ?? 0).toFixed(3)),
        }));
        this.arrayConfig = { ...this.arrayConfig, elements };
        this.cdr.markForCheck();
      });
  }

  private recalcApodizationWeights(): void {
  const n        = this.elements.length;
  const weights  = this.computeWindowWeights(n);
  const elements = this.elements.map((el, i) => ({
    ...el,
    apodizationWeight: weights[i],
  }));
  this.arrayConfig = { ...this.arrayConfig, elements };
  this.cdr.markForCheck();
}

/** Pure window-weight computation */
private computeWindowWeights(n: number): number[] {
  if (n <= 1) return [1];
  const w = this.arrayConfig.apodizationWindow ?? 'none';
  const β = this.arrayConfig.kaiserBeta        ?? 6;
  const α = this.arrayConfig.tukeyAlpha        ?? 0.5;
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    switch (w) {
      case 'hanning' : return 0.5  * (1 - Math.cos(2 * Math.PI * x));
      case 'hamming' : return 0.54 - 0.46 * Math.cos(2 * Math.PI * x);
      case 'blackman': return 0.42 - 0.5  * Math.cos(2 * Math.PI * x)
                                    + 0.08 * Math.cos(4 * Math.PI * x);
      case 'kaiser'  : return this.besselI0(β * Math.sqrt(1 - (2 * x - 1) ** 2))
                             / this.besselI0(β);
      case 'tukey': {
        if (x < α / 2)     return 0.5 * (1 - Math.cos(2 * Math.PI * x / α));
        if (x > 1 - α / 2) return 0.5 * (1 - Math.cos(2 * Math.PI * (1 - x) / α));
        return 1;
      }
      default: return 1;
    }
  });
}

private besselI0(x: number): number {
  let sum = 1, term = 1;
  const hx = x / 2;
  for (let k = 1; k <= 25; k++) {
    term *= (hx / k) ** 2;
    sum  += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

  // ── Beamforming compute ───────────────────────────────────────
  computeBeam(): void {
  this.computing = true;
  this.cdr.markForCheck();
  this.beamformSvc
    .computeBeamforming({
      mode        : 'ultrasound',
      arrayConfig : this.arrayConfig,
      targetAngle : this.arrayConfig.steeringAngle,
      snr         : this.arrayConfig.snr,
      window      : this.arrayConfig.apodizationWindow,
    })
    .pipe(takeUntil(this.destroy$))
    .subscribe(result => {
      this.beamformResult = result;
      this.beamResult.emit(result);
      this.computing = false;
      this.cdr.markForCheck();
    });
}

  // ── Canvas rendering ──────────────────────────────────────────

  private startAnimation(): void {
    const draw = () => {
      this.redrawGeometry();
      this.beamPhase += 0.03;
      this.animFrameId = requestAnimationFrame(draw);
    };
    draw();
  }

  private redrawGeometry(): void {
    const canvas = this.geoCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width  = canvas.offsetWidth  || 320;
    const H = canvas.height = canvas.offsetHeight || 200;

    ctx.clearRect(0, 0, W, H);
    this.drawBackground(ctx, W, H);
    this.drawElements(ctx, W, H);
    this.drawBeam(ctx, W, H);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    // Grid
    ctx.strokeStyle = 'rgba(26,115,232,0.06)';
    ctx.lineWidth   = 0.5;
    const step = 20;
    for (let x = 0; x < W; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Centre cross
    ctx.strokeStyle = 'rgba(26,115,232,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  }

  private elementPositions(W: number, H: number): { x: number; y: number }[] {
    const n    = this.elements.length;
    const geo  = this.arrayConfig.geometry;
    const d    = this.arrayConfig.elementSpacing;
    const R    = this.arrayConfig.curvatureRadius;
    const cx   = W / 2;
    const cy   = H - 30;

    return this.elements.map((_, i) => {
      const offset = (i - (n - 1) / 2) * d;
      if (geo === 'linear') {
        return { x: cx + offset * 1.5, y: cy };
      } else {
        // Curved arc
        const angleRad = (offset / R);
        return {
          x: cx + R * Math.sin(angleRad) * 1.5,
          y: cy - R * (1 - Math.cos(angleRad)) * 0.8,
        };
      }
    });
  }

  private drawElements(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const positions = this.elementPositions(W, H);

    positions.forEach((pos, i) => {
      const el = this.elements[i];
      if (!el) return;

      // Wavefront circles (disabled elements skipped)
      if (el.enabled) {
        const maxR   = 60 + el.intensity * 0.3;
        const numRings = 3;
        for (let r = 0; r < numRings; r++) {
          const radius = ((this.beamPhase * 15 + r * (maxR / numRings)) % maxR);
          const alpha  = (1 - radius / maxR) * 0.35 * (el.intensity / 100);
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = el.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      }

      // Element dot
      const isSelected = el.id === this.selectedElementId;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isSelected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle   = el.enabled ? el.color : '#aaa';
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }

      // Label
      ctx.fillStyle  = '#7a8fa6';
      ctx.font       = 'bold 8px IBM Plex Mono, monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(el.label, pos.x, pos.y - 9);
    });
  }

  private drawBeam(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.elements.some(e => e.enabled)) return;

    const positions = this.elementPositions(W, H);
    const avgX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length;

    const angleRad  = (this.arrayConfig.steeringAngle * Math.PI) / 180;
    const beamLen   = 160;
    const beamEndX  = avgX + beamLen * Math.sin(angleRad);
    const beamEndY  = avgY - beamLen * Math.cos(angleRad);
    const halfWidth = Math.PI / Math.max(this.elements.length, 1) * 30;

    // Beam cone fill
    const grad = ctx.createRadialGradient(avgX, avgY, 5, avgX, avgY, beamLen);
    grad.addColorStop(0, 'rgba(26,115,232,0.35)');
    grad.addColorStop(1, 'rgba(26,115,232,0.0)');

    ctx.beginPath();
    ctx.moveTo(avgX, avgY);
    ctx.arc(avgX, avgY, beamLen, -Math.PI / 2 + angleRad - halfWidth, -Math.PI / 2 + angleRad + halfWidth);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Main beam axis
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(26,115,232,0.9)';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 8;
    ctx.setLineDash([6, 3]);
    ctx.moveTo(avgX, avgY);
    ctx.lineTo(beamEndX, beamEndY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Angle label
    if (this.arrayConfig.steeringAngle !== 0) {
      ctx.fillStyle = '#1a73e8';
      ctx.font      = 'bold 9px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        `${this.arrayConfig.steeringAngle.toFixed(1)}°`,
        beamEndX + 12, beamEndY - 4
      );
    }
  }

  // ── Template helpers ──────────────────────────────────────────

  trackById(_: number, el: ProbeElementConfig): string {
    return el.id;
  }

  timeDomainPoints(data: number[]): string {
    if (!data?.length) return '';
    const W = 300, H = 60;
    const max = Math.max(...data.map(Math.abs), 1e-9);
    return data
      .map((v, i) =>
        `${(i / (data.length - 1)) * W},${H / 2 - (v / max) * (H / 2 - 4)}`
      )
      .join(' ');
  }

  // ── Helpers ───────────────────────────────────────────────────

  private emit(): void {
    this.configChange.emit({ ...this.arrayConfig });
    this.cdr.markForCheck();
  }
}
