import {
  Component,
  NgZone,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { BeamformingService } from '../../../services/beamforming.service';

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

interface DetectionData {
  snr_db:             number;
  estimated_rcs:      number;
  estimated_extent_m: number;   // populated by focused scan; 0 = unknown
  range_m:            number;
  angle_deg:          number;
}

interface RadarTarget {
  id:               string;
  angle:            number;   // bearing degrees, 0 = North, clockwise
  range:            number;   // normalised 0–1 relative to maxRangeKm
  rcs:              number;   // m²
  label:            string;
  lastDetection:    DetectionData | null;
  trdLastDetection: DetectionData | null;
}

@Component({
  selector:        'app-mode-radar',
  standalone:      true,
  imports:         [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl:     './mode-radar.component.html',
  styleUrls:       ['./mode-radar.component.css'],
})
export class ModeRadarComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('bfCanvas',      { static: true }) bfCanvasRef!:      ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas',     { static: true }) trdCanvasRef!:     ElementRef<HTMLCanvasElement>;
  @ViewChild('patternCanvas', { static: true }) patternCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('envCanvas',     { static: true }) envCanvasRef!:     ElementRef<HTMLCanvasElement>;

  // ── Public control state ──────────────────────────────────────────────────
  targets: RadarTarget[] = [];

  steerSpeedDegPerBatch: number = 15;
  readonly Math = Math;

  scanRange:       number = 1;
  numElements:     number = 12;
  elementSpacing:  number = 15.0;   // mm
  apodization:     string = 'hanning';
  frequencyGhz:    number = 9.5;
  readonly apodizationOptions = ['none', 'hanning', 'hamming', 'blackman'];

  txPower:        number = 70.0;
  prfHz:          number = 1000.0;
  pulseWidthUs:   number = 1.0;

  noiseFloorDbm:   number = -100.0;
  clutterFloorDbm: number = -200.0;
  clutterRangeExp: number = -20.0;

  cfarGuardCells:  number = 2;
  cfarRefCells:    number = 8;
  cfarPfa:         number = 1e-4;

  snr: number = 60.0;

  radarInfo:         any    = null;
  interferenceImage: string | null = null;

  // ── Private scan state ────────────────────────────────────────────────────
  private animId:     number  = 0;
  private radarReady: boolean = false;
  private beamPattern:number[] = [];
  private anglesDeg:  number[] = [];

  private bfScanAngle:  number = 0;   // leading edge of current BF sweep (degrees)
  private trdScanAngle: number = 0;   // leading edge of current TRD sweep (degrees)

  private bfRotAccum:  number = 0;    // degrees accumulated this rotation cycle
  private trdRotAccum: number = 0;

  private bfWaitingForAck:  boolean = false;
  private trdWaitingForAck: boolean = false;

  readonly maxRangeKm = 100;

  private bfPaint!:    HTMLCanvasElement;
  private bfPaintCtx!: CanvasRenderingContext2D;
  private trdPaint!:   HTMLCanvasElement;
  private trdPaintCtx!:CanvasRenderingContext2D;

  // ── Environment drag/resize state ─────────────────────────────────────────
  private envDragTarget:     RadarTarget | null = null;
  private envResizeTarget:   RadarTarget | null = null;
  private envResizeStartX:   number = 0;
  private envResizeStartRcs: number = 0;

  // ── Computed getters ───────────────────────────────────────────────────────
  get rangeResolutionM():   number { return this.radarInfo?.range_resolution_m      ?? 0; }
  get maxUnambRangeKm():    number { return (this.radarInfo?.max_unambiguous_range_m ?? 0) / 1000; }
  get arrayGainDb():        number { return this.radarInfo?.array_gain_db            ?? 0; }
  get hpbwDeg():            number { return this.radarInfo?.hpbw_deg                 ?? 0; }
  get sideLobeLevel():      number { return this.radarInfo?.side_lobe_level          ?? -13.5; }
  get wavelengthM():        number { return this.radarInfo?.wavelength_m              ?? 0; }

  isDetected(tgt: RadarTarget):    boolean { return tgt.lastDetection    !== null; }
  isTrdDetected(tgt: RadarTarget): boolean { return tgt.trdLastDetection !== null; }

  get liveDetectedCount():    number { return this.targets.filter(t => this.isDetected(t)).length; }
  get trdLiveDetectedCount(): number { return this.targets.filter(t => this.isTrdDetected(t)).length; }

  constructor(
    private beamSvc: BeamformingService,
    private cdr:     ChangeDetectorRef,
    private zone:    NgZone,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.targets = [
      { id: 't1', angle: 35,  range: 0.55, rcs: 5, label: 'TGT-A', lastDetection: null, trdLastDetection: null },
      { id: 't2', angle: 120, range: 0.70, rcs: 3, label: 'TGT-B', lastDetection: null, trdLastDetection: null },
      { id: 't3', angle: 220, range: 0.40, rcs: 8, label: 'TGT-C', lastDetection: null, trdLastDetection: null },
    ];

    this.beamSvc.openScanSockets();
    this.doSetupRadar();
    this.subscribeToResults();
  }

  ngAfterViewInit(): void {
    const mk = (ref: ElementRef<HTMLCanvasElement>): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width  = ref.nativeElement.offsetWidth  || 400;
      c.height = ref.nativeElement.offsetHeight || 400;
      return c;
    };
    this.bfPaint    = mk(this.bfCanvasRef);
    this.bfPaintCtx = this.bfPaint.getContext('2d')!;
    this.trdPaint    = mk(this.trdCanvasRef);
    this.trdPaintCtx = this.trdPaint.getContext('2d')!;

    this.initEnvCanvas();
    this.startAnimationLoop();

    if (this.radarReady) { this.sendBfBatch(); this.sendTrdBatch(); }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
    this.beamSvc.closeScanSockets();
  }

  trackById(_: number, tgt: RadarTarget): string { return tgt.id; }

  addTarget(): void {
  const idx = this.targets.length;
  this.targets.push({
    id:               `t${Date.now()}`,
    angle:            Math.random() * 360,
    range:            0.3 + Math.random() * 0.6,
    rcs:              5,
    label:            `TGT-${String.fromCharCode(65 + (idx % 26))}`,
    lastDetection:    null,
    trdLastDetection: null,
  });
  this.cdr.markForCheck();
}

removeTarget(id: string): void {
  this.targets = this.targets.filter(t => t.id !== id);
  this.cdr.markForCheck();
}

  // ─────────────────────────────────────────────────────────────────────────
  // Setup
  // ─────────────────────────────────────────────────────────────────────────

  private doSetupRadar(): void {
    this.beamSvc.setupRadar(this.buildSetupRequest()).subscribe({
      next: res => {
        this.radarReady        = true;
        this.radarInfo         = res;
        this.beamPattern       = res.beam_pattern   ?? [];
        this.anglesDeg         = res.angles_deg     ?? [];
        this.interferenceImage = res.interference_image ?? null;
        setTimeout(() => this.drawPatternCanvas(), 0);
        this.cdr.markForCheck();
        this.sendBfBatch();
        this.sendTrdBatch();
      },
      error: e => console.warn('Radar setup failed:', e),
    });
  }

  onHardwareChange(): void {
    this.beamSvc.setupRadar(this.buildSetupRequest()).subscribe({
      next: res => {
        this.radarInfo         = res;
        this.beamPattern       = res.beam_pattern   ?? [];
        this.anglesDeg         = res.angles_deg     ?? [];
        this.interferenceImage = res.interference_image ?? null;
        if (this.bfPaintCtx)  this.bfPaintCtx.clearRect(0, 0, this.bfPaint.width,  this.bfPaint.height);
        if (this.trdPaintCtx) this.trdPaintCtx.clearRect(0, 0, this.trdPaint.width, this.trdPaint.height);
        this.bfRotAccum = this.trdRotAccum = 0;
        setTimeout(() => this.drawPatternCanvas(), 0);
        this.cdr.markForCheck();
      },
      error: e => console.warn('Radar re-setup failed:', e),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Result subscriptions
  // ─────────────────────────────────────────────────────────────────────────

  private subscribeToResults(): void {
    // ── Phased array ────────────────────────────────────────────────────────
    this.beamSvc.bfScanResults$.subscribe(res => {
      try {
        if (res?.sweep_data?.length) {
          this.paintPpi(this.bfPaintCtx, this.bfPaint, res.sweep_data, 'bf');
          const span = this.angleSpan(res.sweep_data.map((l: any) => l.angle_deg));
          this.bfRotAccum  += span;
          this.bfScanAngle  = (this.bfScanAngle + span) % 360;
          if (this.bfRotAccum >= 360) {
            this.bfRotAccum = 0;
            this.bfPaintCtx.clearRect(0, 0, this.bfPaint.width, this.bfPaint.height);
            this.targets.forEach(t => (t.lastDetection = null));
            this.zone.run(() => this.cdr.markForCheck());
          }
        }
        if (res?.detections?.length) {
          this.applyDetections(res.detections, 'bf');
        }
        if (res.interference_image) {
          this.interferenceImage = res.interference_image;
          this.cdr.markForCheck();
        }
        if (res.beam_pattern?.length) {
          this.beamPattern = res.beam_pattern;
          this.anglesDeg   = res.angles_deg ?? this.anglesDeg;
          if (res.beam_angle != null || res.main_lobe_width != null || res.side_lobe_level != null) {
            this.radarInfo = {
              ...this.radarInfo,
              beam_angle:      res.beam_angle      ?? this.radarInfo?.beam_angle,
              main_lobe_width: res.main_lobe_width ?? this.radarInfo?.main_lobe_width,
              side_lobe_level: res.side_lobe_level ?? this.radarInfo?.side_lobe_level,
            };
          }
          this.drawPatternCanvas();
        }
      } catch (e) { console.warn('bf result error:', e); }
      finally { this.bfWaitingForAck = false; this.sendBfBatch(); }
    });

    // ── Traditional / mechanical ────────────────────────────────────────────
    this.beamSvc.trdScanResults$.subscribe(res => {
      try {
        if (res?.sweep_data?.length) {
          this.paintPpi(this.trdPaintCtx, this.trdPaint, res.sweep_data, 'trd');
          const span = this.angleSpan(res.sweep_data.map((l: any) => l.angle_deg));
          this.trdRotAccum  += span;
          this.trdScanAngle  = (this.trdScanAngle + span) % 360;
          if (this.trdRotAccum >= 360) {
            this.trdRotAccum = 0;
            this.trdPaintCtx.clearRect(0, 0, this.trdPaint.width, this.trdPaint.height);
            this.targets.forEach(t => (t.trdLastDetection = null));
            this.zone.run(() => this.cdr.markForCheck());
          }
        }
        if (res?.detections?.length) {
          this.applyDetections(res.detections, 'trd');
        }
      } catch (e) { console.warn('trd result error:', e); }
      finally { this.trdWaitingForAck = false; this.sendTrdBatch(); }
    });
  }

  private applyDetections(detections: any[], radar: 'bf' | 'trd'): void {
    let changed = false;
    this.targets.forEach(tgt => {
      const d = detections.find((x: any) => x.target_id === tgt.id);
      if (!d) return;
      const det: DetectionData = {
        snr_db:             d.snr_db,
        estimated_rcs:      d.estimated_rcs,
        estimated_extent_m: d.estimated_extent_m ?? 0,
        range_m:            d.range_m,
        angle_deg:          d.angle_deg,
      };
      if (radar === 'bf') tgt.lastDetection    = det;
      else                tgt.trdLastDetection = det;
      changed = true;
    });
    if (changed) this.zone.run(() => this.cdr.markForCheck());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scan batch senders
  // ─────────────────────────────────────────────────────────────────────────

  private sendBfBatch(): void {
    if (!this.radarReady || this.bfWaitingForAck || !this.bfPaintCtx) return;
    this.bfWaitingForAck = true;
    this.beamSvc.sendBfScanSlice({
      start_angle:    this.bfScanAngle,
      end_angle:      this.bfScanAngle + this.steerSpeedDegPerBatch,
      num_lines:      Math.max(1, Math.round(this.steerSpeedDegPerBatch)),
      max_range_m:    this.scanRange * this.maxRangeKm * 1000,
      num_range_bins: 128,
      targets:        this.targets.map(t => this.toTargetDTO(t)),
    });
  }

  private sendTrdBatch(): void {
    if (!this.radarReady || this.trdWaitingForAck || !this.trdPaintCtx) return;
    this.trdWaitingForAck = true;
    const LINES = 15, DEG = 0.5;
    this.beamSvc.sendTrdScanSlice({
      start_angle:    this.trdScanAngle,
      end_angle:      this.trdScanAngle + LINES * DEG,
      num_lines:      LINES,
      max_range_m:    this.scanRange * this.maxRangeKm * 1000,
      num_range_bins: 128,
      targets:        this.targets.map(t => this.toTargetDTO(t)),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private buildSetupRequest(): any {
    return {
      num_elements:      this.numElements,
      element_spacing:   this.elementSpacing,
      frequency_mhz:     this.frequencyGhz * 1000,
      geometry:          'linear',
      curvature_radius:  0.0,
      steering_angle:    0.0,
      focus_depth:       0.0,
      snr:               this.snr,
      apodization:       this.apodization,
      pt_dbm:            this.txPower,
      prf_hz:            this.prfHz,
      pulse_width_us:    this.pulseWidthUs,
      noise_floor_dbm:   this.noiseFloorDbm,
      clutter_floor_dbm: this.clutterFloorDbm,
      clutter_range_exp: this.clutterRangeExp,
      cfar_guard_cells:  this.cfarGuardCells,
      cfar_ref_cells:    this.cfarRefCells,
      cfar_pfa:          this.cfarPfa,
    };
  }

  /**
   * Convert target (normalised bearing + range) to backend Cartesian (m).
   * x_m = East, y_m = North.  Formula: x = R·sin(θ), y = R·cos(θ).
   * Uses full maxRangeKm — scanRange is handled by max_range_m in the request.
   */
  private toTargetDTO(t: RadarTarget): any {
    const range_m   = t.range * this.maxRangeKm * 1000;
    const angle_rad = (t.angle * Math.PI) / 180;
    return {
      target_id:       t.id,
      x_m:             range_m * Math.sin(angle_rad),
      y_m:             range_m * Math.cos(angle_rad),
      rcs_sqm:         t.rcs,
      target_extent_m: 0,
    };
  }

  /** Degrees spanned by a set of sweep-line angles (wrapping-aware). */
  private angleSpan(angles: number[]): number {
    if (!angles.length) return 0;
    if (angles.length === 1) return 1;
    const min = Math.min(...angles), max = Math.max(...angles);
    return Math.min(max - min, (min + 360) - max) + 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PPI paint — writes to off-screen canvas
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Paint one batch of sweep lines.
   *
   * Angular width of each wedge = step between adjacent lines (stepDeg).
   * This ensures perfect tiling: no gaps, no overlap.
   *
   * Color: single hue per radar, brightness = intensity only.
   * 0 = transparent, 1 = opaque.  No false-color gradients.
   */
  private paintPpi(
    ctx:      CanvasRenderingContext2D,
    off:      HTMLCanvasElement,
    data:     any[],
    radar:    'bf' | 'trd',
  ): void {
    if (!ctx || !data.length) return;
    const W = off.width, H = off.height;
    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) / 2 - 16;

    const sorted  = [...data].sort((a, b) => a.angle_deg - b.angle_deg);
    const rawStep = sorted.length > 1
      ? (sorted[sorted.length - 1].angle_deg - sorted[0].angle_deg) / (sorted.length - 1)
      : 1.0;
    const stepDeg = Math.max(0.1, Math.min(5.0, rawStep));
    const halfRad = (stepDeg / 2 * Math.PI) / 180;

    const bR = radar === 'bf' ? 26  : 52;
    const bG = radar === 'bf' ? 115 : 168;
    const bB = radar === 'bf' ? 232 : 83;

    ctx.globalCompositeOperation = 'source-over';

    for (const line of data) {
      const bins    = line.range_bins as number[];
      const nBins   = bins.length;
      const sRad    = ((line.angle_deg - 90) * Math.PI) / 180;

      for (let i = 0; i < nBins; i++) {
        const v = bins[i];
        if (v < 0.05) continue;
        const r0 = (i       / nBins) * R;
        const r1 = ((i + 1) / nBins) * R;
        ctx.beginPath();
        ctx.arc(cx, cy, r1, sRad - halfRad, sRad + halfRad);
        ctx.arc(cx, cy, r0, sRad + halfRad, sRad - halfRad, true);
        ctx.closePath();
        ctx.fillStyle = `rgba(${bR},${bG},${bB},${(0.12 + v * 0.83).toFixed(2)})`;
        ctx.fill();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Display compositing — runs every animation frame
  // ─────────────────────────────────────────────────────────────────────────

  private startAnimationLoop(): void {
    this.zone.runOutsideAngular(() => {
      const loop = () => {
        this.drawEnvCanvas();
        this.compositeRadar(this.bfCanvasRef,  this.bfPaint,  this.bfPaintCtx,  'bf',  this.bfScanAngle);
        this.compositeRadar(this.trdCanvasRef, this.trdPaint, this.trdPaintCtx, 'trd', this.trdScanAngle);
        this.animId = requestAnimationFrame(loop);
      };
      loop();
    });
  }

  /**
   * Composite one PPI display canvas:
   * background → grid → accumulated sweep data → cursor → HUD → detections.
   */
  private compositeRadar(
    ref:    ElementRef<HTMLCanvasElement>,
    off:    HTMLCanvasElement,
    offCtx: CanvasRenderingContext2D,
    radar:  'bf' | 'trd',
    cursor: number,
  ): void {
    const canvas = ref?.nativeElement;
    if (!canvas || !offCtx) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = canvas.offsetWidth || 400, H = canvas.offsetHeight || 400;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      off.width = W;    off.height = H;
    }
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 16;
    const rgb = radar === 'bf' ? '26,115,232' : '52,168,83';

    ctx.fillStyle = radar === 'bf' ? '#04080f' : '#040b04';
    ctx.fillRect(0, 0, W, H);

    this.drawPpiGrid(ctx, cx, cy, R, rgb);
    ctx.drawImage(off, 0, 0);

    // Cursor line at leading sweep edge
    const cRad = ((cursor - 90) * Math.PI) / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(cRad), cy + R * Math.sin(cRad));
    ctx.strokeStyle = `rgba(${rgb},0.55)`; ctx.lineWidth = 1; ctx.stroke();

    if (radar === 'bf' && this.radarInfo) this.drawHud(ctx, W, H);
    this.drawDetections(ctx, cx, cy, R, radar);
  }

  private drawPpiGrid(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, rgb: string): void {
    ctx.save(); ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach(f => {
      const r = R * f;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb},0.12)`; ctx.stroke();
      ctx.fillStyle   = `rgba(${rgb},0.40)`; ctx.font = '7px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${(f * this.scanRange * this.maxRangeKm).toFixed(0)}km`,
        cx + r * Math.cos(-Math.PI / 5), cy + r * Math.sin(-Math.PI / 5));
    });
    for (let a = 0; a < 360; a += 45) {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
      ctx.strokeStyle = `rgba(${rgb},0.08)`; ctx.stroke();
    }
    ['N','E','S','W'].forEach((l, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      ctx.fillStyle = `rgba(${rgb},0.55)`; ctx.font = 'bold 8px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(l, cx + (R + 11) * Math.cos(a), cy + (R + 11) * Math.sin(a) + 3);
    });
    ctx.restore();
  }

  /**
   * Draw detection markers at the radar's ESTIMATED position of each target
   * (range_m + angle_deg from the detection, NOT ground-truth coordinates).
   */
  private drawDetections(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, radar: 'bf' | 'trd'): void {
    const maxR = this.scanRange * this.maxRangeKm * 1000;
    for (const tgt of this.targets) {
      const det = radar === 'bf' ? tgt.lastDetection : tgt.trdLastDetection;
      if (!det) continue;
      const nr  = Math.min(det.range_m / maxR, 1.0);
      const rad = ((det.angle_deg - 90) * Math.PI) / 180;
      const px  = cx + nr * R * Math.cos(rad);
      const py  = cy + nr * R * Math.sin(rad);
      const rgb = radar === 'bf' ? '26,115,232' : '52,168,83';

      // Diamond marker
      ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = `rgba(${rgb},0.90)`; ctx.lineWidth = 1.5;
      ctx.strokeRect(-4, -4, 8, 8);
      ctx.restore();

      // Label
      ctx.fillStyle = `rgba(${rgb},0.85)`; ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${tgt.label} ${det.snr_db.toFixed(0)}dB`, px + 7, py - 2);

      // Size estimate (focused scan only)
      if (det.estimated_extent_m > 0) {
        ctx.fillStyle = `rgba(${rgb},0.55)`; ctx.font = '7px IBM Plex Mono, monospace';
        ctx.fillText(`~${det.estimated_extent_m.toFixed(0)}m`, px + 7, py + 8);
      }
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const ri = this.radarInfo;
    const lines = [
      `Fc: ${(ri.carrier_freq_hz / 1e9).toFixed(2)} GHz`,
      `λ:  ${(ri.wavelength_m * 100).toFixed(1)} cm`,
      `G:  ${ri.array_gain_db?.toFixed(1)} dBi`,
      `HPBW: ${ri.hpbw_deg?.toFixed(2)}°`,
      `ΔR: ${ri.range_resolution_m?.toFixed(0)} m`,
      `Ru: ${(ri.max_unambiguous_range_m / 1000).toFixed(0)} km`,
    ];
    ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      const x = 6, y = 14 + i * 11;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x - 2, y - 9, 102, 11);
      ctx.fillStyle = 'rgba(26,115,232,0.85)'; ctx.fillText(line, x, y);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Beam pattern polar plot
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Draw the 360° antenna beam pattern received from the backend.
   *
   * The backend returns a single 0°–360° pattern for one array.
   * It is drawn ONCE, not four times.  The original code rotated the same
   * pattern 4× by 90° offsets — that produced a symmetric 4-lobe picture
   * that has nothing to do with the actual single-array pattern.
   */
  private drawPatternCanvas(): void {
    const el = this.patternCanvasRef?.nativeElement;
    if (!el || !this.beamPattern.length) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const W      = (el.width  = el.offsetWidth  || 400);
    const H      = (el.height = el.offsetHeight || 400);
    const cx     = W / 2, cy = H / 2;
    const radius = Math.min(W, H) / 2 - 24;

    ctx.fillStyle = '#04080f'; ctx.fillRect(0, 0, W, H);

    const DB_FLOOR = -40;
    const norm = this.beamPattern.map(db =>
      Math.max(0, Math.min(1, (Math.max(db, DB_FLOOR) - DB_FLOOR) / -DB_FLOOR))
    );

    // dB rings
    [10, 20, 30, 40].forEach(dbDown => {
      const r = radius * (1 - dbDown / 40);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(26,115,232,${0.06 + (40 - dbDown) / 40 * 0.14})`;
      ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = 'rgba(26,115,232,0.45)'; ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(`-${dbDown}dB`, cx + r + 2, cy - 2);
    });
    // -3 dB ring
    { const r3 = radius * (1 - 3 / 40);
      ctx.beginPath(); ctx.arc(cx, cy, r3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(26,115,232,0.45)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(26,115,232,0.55)'; ctx.fillText('-3dB', cx + r3 + 2, cy - 2); }

    // Spokes + labels
    [0, 45, 90, 135, 180, 225, 270, 315].forEach(a => {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
      ctx.strokeStyle = 'rgba(26,115,232,0.08)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = 'rgba(26,115,232,0.55)'; ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${a}°`, cx + (radius + 14) * Math.cos(rad), cy + (radius + 14) * Math.sin(rad) + 3);
    });

    // Pattern — fill
    ctx.beginPath();
    let first = true;
    this.anglesDeg.forEach((angle, i) => {
      const r = norm[i] * radius, rad = ((angle - 90) * Math.PI) / 180;
      const px = cx + r * Math.cos(rad), py = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
    });
    ctx.closePath();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, 'rgba(26,115,232,0.18)'); g.addColorStop(1, 'rgba(26,115,232,0.02)');
    ctx.fillStyle = g; ctx.fill();

    // Pattern — stroke
    ctx.beginPath(); first = true;
    this.anglesDeg.forEach((angle, i) => {
      const r = norm[i] * radius, rad = ((angle - 90) * Math.PI) / 180;
      const px = cx + r * Math.cos(rad), py = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(26,115,232,0.90)'; ctx.lineWidth = 1.5; ctx.stroke();

    // Steering marker
    const beamAngle = this.radarInfo?.beam_angle ?? this.bfScanAngle;
    const sRad      = ((beamAngle - 90) * Math.PI) / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + radius * Math.cos(sRad), cy + radius * Math.sin(sRad));
    ctx.strokeStyle = 'rgba(255,100,60,0.70)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);

    // Metrics
    ctx.fillStyle = 'rgba(26,115,232,0.60)'; ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'right';
    ctx.fillText(`HPBW ${this.hpbwDeg.toFixed(2)}°  SLL ${this.sideLobeLevel.toFixed(1)}dB`, W - 4, H - 6);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Environment canvas
  // ─────────────────────────────────────────────────────────────────────────

  private initEnvCanvas(): void {
    const canvas = this.envCanvasRef?.nativeElement;
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const { cx, cy, R } = this.envMetrics(canvas);
      const mx = e.offsetX, my = e.offsetY;

      if (e.button === 2) {
        let nearest: RadarTarget | null = null, nd = 20;
        this.targets.forEach(t => { const d = Math.hypot(...this.targetXY(t, cx, cy, R).map((v, i) => v - [mx, my][i]) as [number, number]); if (d < nd) { nd = d; nearest = t; } });
        if (nearest) this.zone.run(() => this.removeTarget((nearest as RadarTarget).id));
        return;
      }
      if (e.button === 1) {
        let hit: RadarTarget | null = null, hd = 24;
        this.targets.forEach(t => { const [tx, ty] = this.targetXY(t, cx, cy, R); const d = Math.hypot(tx - mx, ty - my); if (d < hd) { hd = d; hit = t; } });
        if (hit) { this.envResizeTarget = hit; this.envResizeStartX = mx; this.envResizeStartRcs = (hit as RadarTarget).rcs; }
        return;
      }
      // Left-click: drag or add
      let hit: RadarTarget | null = null, hd = 20;
      this.targets.forEach(t => { const [tx, ty] = this.targetXY(t, cx, cy, R); const d = Math.hypot(tx - mx, ty - my); if (d < Math.max(hd, this.targetVisR(t) + 4)) { hd = d; hit = t; } });
      if (hit) { this.envDragTarget = hit; return; }
      const dx = mx - cx, dy = my - cy;
      const r = Math.min(Math.hypot(dx, dy) / R, 1.0);
      const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      this.zone.run(() => {
        this.targets.push({ id: `t${Date.now()}`, angle: a, range: r, rcs: 5,
          label: `TGT-${String.fromCharCode(65 + (this.targets.length % 26))}`,
          lastDetection: null, trdLastDetection: null });
        this.cdr.markForCheck();
      });
    });

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const { cx, cy, R } = this.envMetrics(canvas);
      if (this.envDragTarget) {
        const dx = e.offsetX - cx, dy = e.offsetY - cy;
        this.envDragTarget.range = Math.min(Math.hypot(dx, dy) / R, 1.0);
        this.envDragTarget.angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        return;
      }
      if (this.envResizeTarget) {
        this.envResizeTarget.rcs = Math.round(
          Math.max(0.5, Math.min(100, this.envResizeStartRcs + (e.offsetX - this.envResizeStartX) * 0.3)) * 10
        ) / 10;
      }
    });

    canvas.addEventListener('mouseup',    () => { this.envDragTarget = null; this.envResizeTarget = null; });
    canvas.addEventListener('mouseleave', () => { this.envDragTarget = null; this.envResizeTarget = null; });
    canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());
  }

  private envMetrics(c: HTMLCanvasElement) {
    return { cx: c.width / 2, cy: c.height / 2, R: Math.min(c.width, c.height) / 2 - 20 };
  }

  private targetXY(t: RadarTarget, cx: number, cy: number, R: number): [number, number] {
    const rad = ((t.angle - 90) * Math.PI) / 180, d = Math.min(t.range, 1.0) * R;
    return [cx + d * Math.cos(rad), cy + d * Math.sin(rad)];
  }

  private targetVisR(t: RadarTarget): number { return 4 + Math.sqrt(Math.max(t.rcs, 0.5)) * 1.4; }

  private drawEnvCanvas(): void {
    const canvas = this.envCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width  = canvas.offsetWidth  || 400);
    const H = (canvas.height = canvas.offsetHeight || 200);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 20;

    ctx.fillStyle = '#050a0f'; ctx.fillRect(0, 0, W, H);

    // Cartesian grid
    ctx.strokeStyle = 'rgba(232,168,43,0.10)'; ctx.lineWidth = 0.5;
    const step = R / 4;
    for (let gx = cx - R; gx <= cx + R + 1; gx += step) { ctx.beginPath(); ctx.moveTo(gx, cy - R); ctx.lineTo(gx, cy + R); ctx.stroke(); }
    for (let gy = cy - R; gy <= cy + R + 1; gy += step) { ctx.beginPath(); ctx.moveTo(cx - R, gy); ctx.lineTo(cx + R, gy); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(232,168,43,0.30)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();

    [0.25, 0.5, 0.75, 1.0].forEach(f => {
      const r = R * f, km = (f * this.maxRangeKm * this.scanRange).toFixed(0);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(232,168,43,0.14)'; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.fillStyle = 'rgba(232,168,43,0.35)'; ctx.font = '7px IBM Plex Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${km}km`, cx + r + 2, cy - 2);
    });
    ctx.fillStyle = 'rgba(232,168,43,0.5)'; ctx.font = 'bold 8px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]].forEach(([l, dx, dy]) =>
      ctx.fillText(l as string, cx + (dx as number) * (R + 12), cy + (dy as number) * (R + 12) + 3));

    this.targets.forEach(tgt => {
      const [tx, ty] = this.targetXY(tgt, cx, cy, R);
      const isDrag   = this.envDragTarget   === tgt;
      const isResize = this.envResizeTarget === tgt;
      const det      = this.isDetected(tgt) || this.isTrdDetected(tgt);
      const visR     = this.targetVisR(tgt);
      const rgb      = det ? '52,168,83' : isDrag ? '255,200,50' : isResize ? '100,200,255' : '232,168,43';

      const grd = ctx.createRadialGradient(tx, ty, 0, tx, ty, visR);
      grd.addColorStop(0, `rgba(${rgb},0.50)`); grd.addColorStop(1, `rgba(${rgb},0.00)`);
      ctx.beginPath(); ctx.arc(tx, ty, visR, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
      ctx.beginPath(); ctx.arc(tx, ty, visR, 0, Math.PI * 2); ctx.strokeStyle = `rgba(${rgb},0.85)`; ctx.lineWidth = isDrag || isResize ? 2 : 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, 2, 0, Math.PI * 2); ctx.fillStyle = `rgba(${rgb},1)`; ctx.fill();

      ctx.fillStyle = `rgba(${rgb},1)`; ctx.font = 'bold 9px IBM Plex Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(tgt.label, tx + visR + 3, ty - 3);
      ctx.font = '7px IBM Plex Mono, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(`${(tgt.range * this.maxRangeKm * this.scanRange).toFixed(0)}km  ${tgt.angle.toFixed(0)}°  ${tgt.rcs.toFixed(1)}m²`, tx + visR + 3, ty + 8);
    });

    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fillStyle = 'rgba(232,168,43,0.7)'; ctx.fill();
    ctx.strokeStyle = 'rgba(232,168,43,0.9)'; ctx.lineWidth = 1; ctx.stroke();
  }
}
