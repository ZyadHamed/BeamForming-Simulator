// ══════════════════════════════════════════════════════════════════
//  BeamformingViewerComponent
//
//  Three-panel live beamforming viewer:
//    Panel 1 – <app-probe-array>   (reuses existing component)
//    Panel 2 – Interference map    (2-D pressure-field heatmap)
//    Panel 3 – Beam profile        (polar or Cartesian amplitude)
//
//  FFT/IFFT-heavy calculations that belong on the backend are
//  clearly marked with  ← BACKEND PLACEHOLDER  comments and call
//  stub methods that emit the data shape the backend should return.
//
//  New global parameters added on top of what probe-array already
//  manages:
//    • SNR          (0–1000)
//    • Apodization window  (none | hanning | hamming | blackman | kaiser | tukey)
//    • Kaiser β  / Tukey α  (window-specific shape parameters)
// ══════════════════════════════════════════════════════════════════

import {
  Component, OnInit, OnDestroy, AfterViewInit,
  ViewChild, ElementRef, ChangeDetectionStrategy,
  ChangeDetectorRef, NgZone, Input, Output, EventEmitter
} from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';
import { Subject, takeUntil, debounceTime } from 'rxjs';

import { ProbeArrayComponent }   from '../probe-array/probe-array.component';
import { BeamformingService }    from '../../services/beamforming.service';
import {
  ArrayConfig, BeamformingResult,
  makeDefaultArrayConfig, 
} from '../../models/beamforming.models';

// ── Local types ──────────────────────────────────────────────────
export type ApodizationWindow = 'none' | 'hanning' | 'hamming' | 'blackman' | 'kaiser' | 'tukey';
export type BeamProfileMode   = 'polar' | 'cartesian';
export type MapColorScale      = 'linear' | 'dB';


export interface GlobalBeamConfig {
  snr                : number;          // 0 – 1000
  apodizationWindow  : ApodizationWindow;
  kaiserBeta         : number;          // Kaiser-specific β  (0–14)
  tukeyAlpha         : number;          // Tukey-specific α   (0–1)
}

export interface HoverCoords {
  x  : number;   // mm
  z  : number;   // mm (depth)
  amp: number;   // normalised amplitude at that pixel
}

// ── Backend response shapes (placeholders) ───────────────────────
/** Shape the backend should return for the interference field */
export interface InterferenceFieldResult {
  /** Flat row-major Float32Array of normalised amplitudes [0–1], size = cols × rows */
  field      : Float32Array | number[];
  cols       : number;
  rows       : number;
  xExtentMm  : number;    // total lateral extent  (–xExtentMm/2 … +xExtentMm/2)
  zExtentMm  : number;    // total depth extent    (0 … zExtentMm)
}

/** Shape the backend should return for the beam profile */
export interface BeamProfileResult {
  /** Angles in degrees, e.g. –90 … +90 */
  angles       : number[];
  /** Normalised amplitude at each angle (0–1) */
  amplitudes   : number[];
  /** Time-domain combined signal after IFFT */
  timeDomain   : number[];
}

@Component({
  selector       : 'app-beamforming-viewer',
  standalone     : true,
  imports        : [CommonModule, FormsModule, ProbeArrayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './beamforming-viewer.component.html',
  styleUrls      : ['./beamforming-viewer.component.css'],
})
export class BeamformingViewerComponent implements OnInit, AfterViewInit, OnDestroy {

  // ── Canvas refs ────────────────────────────────────────────────
  @ViewChild('interferenceCanvas') interferenceCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('colorbarCanvas')     colorbarCanvasRef!    : ElementRef<HTMLCanvasElement>;
  @ViewChild('beamProfileCanvas')  beamProfileCanvasRef! : ElementRef<HTMLCanvasElement>;
  @ViewChild('timeDomainCanvas')   timeDomainCanvasRef!  : ElementRef<HTMLCanvasElement>;

  @Input()  set initialConfig(cfg: ArrayConfig) { this.arrayConfig = { ...cfg }; }
  @Output() configChange = new EventEmitter<ArrayConfig>();
  @Output() beamResultChange = new EventEmitter<BeamformingResult>();
  
  // ── State ──────────────────────────────────────────────────────
  arrayConfig      : ArrayConfig          = makeDefaultArrayConfig(4);
  globalConfig     : GlobalBeamConfig     = {
    snr               : 100,
    apodizationWindow : 'hanning',
    kaiserBeta        : 6,
    tukeyAlpha        : 0.5,
  };

  beamProfileMode  : BeamProfileMode  = 'polar';
  mapResolution    : number           = 128;
  mapColorScale    : MapColorScale    = 'dB';
  mapDepthMm       : number           = 150;

  computing        : boolean          = false;
  backendPending   : boolean          = false;
  latestResult     : BeamformingResult | null = null;
  hoverCoords      : HoverCoords | null = null;

  // Internal cached field data
  private interferenceField : InterferenceFieldResult | null = null;
  private beamProfile       : BeamProfileResult | null       = null;

  private animFrameId  : number  = 0;
  private animPhase    : number  = 0;
  private redraw$      = new Subject<void>();
  private destroy$     = new Subject<void>();
  private resizeObs!   : ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;


  constructor(
    private beamformSvc : BeamformingService,
    private cdr         : ChangeDetectorRef,
    private zone        : NgZone,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────

  ngOnInit(): void {
    // Debounce rapid slider changes so we don't hammer the backend
    this.redraw$
      .pipe(debounceTime(80), takeUntil(this.destroy$))
      .subscribe(() => this.redrawAll());
  }

  ngAfterViewInit(): void {
    this.drawColorbar();
    this.scheduleRedraw();
    this.startAnimation();
    this.attachHoverListener();
    this.attachResizeObserver();
  }

ngOnDestroy(): void {
  cancelAnimationFrame(this.animFrameId);

  // Clear pending resize redraw
  if (this.resizeTimer !== null) {
    clearTimeout(this.resizeTimer);
  }

  this.resizeObs?.disconnect();
  this.destroy$.next();
  this.destroy$.complete();
}

  // ── Event handlers ────────────────────────────────────────────

  onArrayConfigChange(cfg: ArrayConfig): void {
    this.arrayConfig = cfg;
    this.configChange.emit(cfg)
    this.scheduleRedraw();
  }

  onBeamResult(result: BeamformingResult): void {
    this.latestResult = result;
    this.beamResultChange.emit(result)
    this.cdr.markForCheck();
    this.redrawBeamProfile();
    this.redrawTimeDomain(result.timeDomain);
  }

  onGlobalChange(): void {
    this.scheduleRedraw();
  }

  scheduleRedraw(): void {
    this.redraw$.next();
  }

  redrawAll(): void {
    this.triggerCompute();
  }

  // ── Compute orchestration ──────────────────────────────────────

  triggerCompute(): void {
    if (this.computing) return;
    this.computing = true;
    this.cdr.markForCheck();

    // 1. Ask the existing BeamformingService for the standard result
    this.beamformSvc
      .computeBeamforming({
        mode        : 'ultrasound',
        arrayConfig : this.arrayConfig,
        targetAngle : this.arrayConfig.steeringAngle,
      })
      .pipe(takeUntil(this.destroy$))
      .subscribe(result => {
        this.latestResult = result;
        this.computing    = false;
        this.cdr.markForCheck();

        // 2. Now compute the two visualisation data sets
        this.computeInterferenceField();
        this.computeBeamProfile();
      });
  }

  // ── Backend placeholder: Interference field ────────────────────
  /**
   * BACKEND PLACEHOLDER
   * ──────────────────────────────────────────────────────────────
   * Send to backend:
   *   POST /api/beamforming/interference-field
   *   Body: {
   *     elements      : arrayConfig.elements,      // positions, delays, phases, weights
   *     steeringAngle : arrayConfig.steeringAngle,
   *     focusDepth    : arrayConfig.focusDepth,
   *     geometry      : arrayConfig.geometry,
   *     elementSpacing: arrayConfig.elementSpacing,
   *     snr           : globalConfig.snr,
   *     window        : globalConfig.apodizationWindow,
   *     kaiserBeta    : globalConfig.kaiserBeta,
   *     tukeyAlpha    : globalConfig.tukeyAlpha,
   *     cols          : mapResolution,
   *     rows          : mapResolution,
   *     depthMm       : mapDepthMm,
   *   }
   *
   * Expected response: InterferenceFieldResult
   *   { field: Float32Array, cols, rows, xExtentMm, zExtentMm }
   *
   * The backend should:
   *   1. Compute element weights from the chosen apodization window.
   *   2. For each grid point, sum the complex pressure contribution
   *      from every enabled element (phase-shifted + delayed FFT).
   *   3. Apply IFFT to get the time-domain envelope.
   *   4. Normalise and apply the SNR noise floor.
   *   5. Return the magnitude map.
   *
   * Until the backend is ready, we synthesise an approximate field
   * analytically here on the client.
   */
  private computeInterferenceField(): void {
    this.backendPending = true;
    this.cdr.markForCheck();

    // ── Client-side approximation (replace with HTTP call) ──────
    const cols = this.mapResolution;
    const rows = this.mapResolution;
    const field = new Float32Array(cols * rows);

    const elements = this.arrayConfig.elements.filter(e => e.enabled);
    if (elements.length === 0) {
      this.interferenceField = { field, cols, rows, xExtentMm: 100, zExtentMm: this.mapDepthMm };
      this.redrawInterference();
      this.backendPending = false;
      this.cdr.markForCheck();
      return;
    }

    const weights    = this.apodizationWeights(elements.length);
    const steeringRad = (this.arrayConfig.steeringAngle * Math.PI) / 180;
    const lambda     = 1.5;           // approximate wavelength in mm (speed 1500 m/s @ 1 MHz)
    const k          = (2 * Math.PI) / lambda;
    const d          = this.arrayConfig.elementSpacing;
    const xExtentMm  = Math.max(d * elements.length * 2, 60);
    const zExtentMm  = this.mapDepthMm;
    const snrFactor  = this.snrNoiseFloor();

    for (let row = 0; row < rows; row++) {
      const z = (row / (rows - 1)) * zExtentMm + 1;             // depth  mm

      for (let col = 0; col < cols; col++) {
        const x = ((col / (cols - 1)) - 0.5) * xExtentMm;       // lateral mm

        let re = 0, im = 0;
        elements.forEach((el, i) => {
          const ex = (i - (elements.length - 1) / 2) * d;        // element x in mm
          const r  = Math.sqrt((x - ex) ** 2 + z ** 2);
          const steeringDelay = (el.timeDelay ?? 0) * 1e-6 * 1500 * 1000; // µs → mm
          const phaseRad = k * (r - steeringDelay) + (el.phaseShift * Math.PI / 180);
          const amp = (el.intensity / 100) * weights[i];
          re += amp * Math.cos(phaseRad) / Math.max(r, 1);
          im += amp * Math.sin(phaseRad) / Math.max(r, 1);
        });

        const mag = Math.sqrt(re * re + im * im);
        field[row * cols + col] = mag + snrFactor * (Math.random() - 0.5);
      }
    }

    // Normalise
    let maxVal = 0;
    for (let i = 0; i < field.length; i++) if (field[i] > maxVal) maxVal = field[i];
    if (maxVal > 0) for (let i = 0; i < field.length; i++) field[i] = Math.max(0, field[i] / maxVal);

    this.interferenceField = { field, cols, rows, xExtentMm, zExtentMm };
    this.redrawInterference();
    this.backendPending = false;
    this.cdr.markForCheck();
  }

  // ── Backend placeholder: Beam profile ─────────────────────────
  /**
   * BACKEND PLACEHOLDER
   * ──────────────────────────────────────────────────────────────
   * Send to backend:
   *   POST /api/beamforming/beam-profile
   *   Body: { ...same as interference-field... }
   *
   * Expected response: BeamProfileResult
   *   { angles: number[], amplitudes: number[], timeDomain: number[] }
   *
   * The backend should:
   *   1. Apply apodization weights to element excitations.
   *   2. FFT each element signal.
   *   3. Steer + sum across angles (–90° to +90°) to obtain the
   *      far-field array factor.
   *   4. Apply the SNR noise model.
   *   5. IFFT the steered sum to obtain the time-domain output.
   *   6. Return normalised amplitude vs angle + IFFT time signal.
   *
   * Client-side approximation below (replace with HTTP call).
   */
  private computeBeamProfile(): void {
    const N          = 361;
    const angles     = Array.from({ length: N }, (_, i) => -90 + i * (180 / (N - 1)));
    const amplitudes : number[] = [];
    const elements   = this.arrayConfig.elements.filter(e => e.enabled);
    const weights    = this.apodizationWeights(elements.length);
    const d          = this.arrayConfig.elementSpacing;
    const lambda     = 1.5;
    const snrFactor  = this.snrNoiseFloor();

    for (const angle of angles) {
      const rad = (angle * Math.PI) / 180;
      let re = 0, im = 0;
      elements.forEach((el, i) => {
        const ex      = (i - (elements.length - 1) / 2) * d;
        const phase   = (2 * Math.PI / lambda) * ex * Math.sin(rad)
                       + (el.phaseShift * Math.PI / 180)
                       - (el.timeDelay ?? 0) * 2 * Math.PI * (el.frequency * 1e6) * 1e-6;
        const amp = (el.intensity / 100) * weights[i];
        re += amp * Math.cos(phase);
        im += amp * Math.sin(phase);
      });
      amplitudes.push(Math.sqrt(re * re + im * im) + snrFactor * Math.random());
    }

    // Normalise
    const maxAmp = Math.max(...amplitudes, 1e-9);
    const normAmp = amplitudes.map(a => Math.max(0, a / maxAmp));

    // Synthetic time domain (← real IFFT should come from backend)
    const timeDomain = this.syntheticTimeDomain();

    this.beamProfile = { angles, amplitudes: normAmp, timeDomain };
    this.redrawBeamProfile();
    this.redrawTimeDomain(timeDomain);
  }

  // ── Canvas renderers ──────────────────────────────────────────

  /** Draws the 2-D interference heatmap on Panel 2 */
  redrawInterference(): void {
    const canvasEl = this.interferenceCanvasRef?.nativeElement;
    if (!canvasEl || !this.interferenceField) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const { field, cols, rows } = this.interferenceField;
    const W = canvasEl.width  = canvasEl.offsetWidth  || 400;
    const H = canvasEl.height = canvasEl.offsetHeight || 400;

    // Render field into an off-screen ImageData first (perf)
    const offscreen  = document.createElement('canvas');
    offscreen.width  = cols;
    offscreen.height = rows;
    const octx       = offscreen.getContext('2d')!;
    const imgData    = octx.createImageData(cols, rows);

    for (let i = 0; i < field.length; i++) {
      let v = field[i]; // 0–1
      if (this.mapColorScale === 'dB') {
        v = Math.max(0, 1 + Math.log10(Math.max(v, 1e-4)) / 2); // –40 dB floor
      }
      const [r, g, b] = this.heatmapColor(v);
      imgData.data[i * 4 + 0] = r;
      imgData.data[i * 4 + 1] = g;
      imgData.data[i * 4 + 2] = b;
      imgData.data[i * 4 + 3] = 255;
    }
    octx.putImageData(imgData, 0, 0);

    // Scale up to canvas
    ctx.drawImage(offscreen, 0, 0, W, H);

    // Axis labels
    this.drawInterferenceAxes(ctx, W, H);
  }

  private drawInterferenceAxes(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.interferenceField) return;
    const { xExtentMm, zExtentMm } = this.interferenceField;

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font      = '9px IBM Plex Mono, monospace';

    // Centre vertical
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(W / 2, 0, 1, H);

    // Depth labels
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const y   = t * H;
      const mm  = (t * zExtentMm).toFixed(0);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(0, y, W, 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`${mm} mm`, 4, y + 9);
    });

    // Beam direction line
    const angle   = this.arrayConfig.steeringAngle;
    const cx      = W / 2;
    const endX    = cx + Math.tan((angle * Math.PI) / 180) * H;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,200,255,0.65)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.moveTo(cx, 0);
    ctx.lineTo(endX, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Draws beam profile on Panel 3 */
  private redrawBeamProfile(): void {
    const canvasEl = this.beamProfileCanvasRef?.nativeElement;
    if (!canvasEl || !this.beamProfile) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const W = canvasEl.width  = canvasEl.offsetWidth  || 400;
    const H = canvasEl.height = canvasEl.offsetHeight || 350;

    ctx.clearRect(0, 0, W, H);

    if (this.beamProfileMode === 'polar') {
      this.drawPolarProfile(ctx, W, H);
    } else {
      this.drawCartesianProfile(ctx, W, H);
    }
  }

  private drawPolarProfile(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.beamProfile) return;
    const { angles, amplitudes } = this.beamProfile;
    const cx     = W / 2;
    const cy     = H / 2 + 20;
    const radius = Math.min(W, H) / 2 - 24;

    // Grid rings
    [0.25, 0.5, 0.75, 1.0].forEach(r => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * r, Math.PI, 0);
      ctx.strokeStyle = `rgba(26,115,232,${0.05 + r * 0.08})`;
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.fillStyle   = 'rgba(26,115,232,0.4)';
      ctx.font        = '8px IBM Plex Mono, monospace';
      ctx.textAlign   = 'left';
      ctx.fillText(`${(r * 100).toFixed(0)}%`, cx + radius * r + 2, cy - 2);
    });

    // Spokes
    [-90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90].forEach(a => {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
      ctx.strokeStyle = 'rgba(26,115,232,0.06)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      const lx = cx + (radius + 12) * Math.cos(rad);
      const ly = cy + (radius + 12) * Math.sin(rad);
      ctx.fillStyle  = 'rgba(26,115,232,0.6)';
      ctx.font       = '8px IBM Plex Mono, monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(`${a}°`, lx, ly + 3);
    });

    // Beam profile fill
    ctx.beginPath();
    let first = true;
    angles.forEach((angle, i) => {
      const r   = amplitudes[i] * radius;
      const rad = ((angle - 90) * Math.PI) / 180;
      const px  = cx + r * Math.cos(rad);
      const py  = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; }
      else         ctx.lineTo(px, py);
    });
    ctx.closePath();

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, 'rgba(26,115,232,0.45)');
    grad.addColorStop(1, 'rgba(26,115,232,0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Beam profile stroke
    ctx.beginPath();
    first = true;
    angles.forEach((angle, i) => {
      const r   = amplitudes[i] * radius;
      const rad = ((angle - 90) * Math.PI) / 180;
      const px  = cx + r * Math.cos(rad);
      const py  = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; }
      else         ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth   = 1.8;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Steering angle marker
    const steerRad = ((this.arrayConfig.steeringAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * 1.04 * Math.cos(steerRad), cy + radius * 1.04 * Math.sin(steerRad));
    ctx.strokeStyle = 'rgba(255,100,80,0.8)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawCartesianProfile(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.beamProfile) return;
    const { angles, amplitudes } = this.beamProfile;
    const pad = { l: 36, r: 12, t: 12, b: 24 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    // Background grid
    ctx.strokeStyle = 'rgba(26,115,232,0.06)';
    ctx.lineWidth   = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const y = pad.t + ph * (1 - t);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.fillStyle  = 'rgba(26,115,232,0.5)';
      ctx.font       = '8px IBM Plex Mono, monospace';
      ctx.textAlign  = 'right';
      ctx.fillText(`${(t * 100).toFixed(0)}%`, pad.l - 3, y + 3);
    });

    // X-axis labels
    [-90, -60, -30, 0, 30, 60, 90].forEach(a => {
      const x = pad.l + ((a + 90) / 180) * pw;
      ctx.beginPath();
      ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph);
      ctx.strokeStyle = 'rgba(26,115,232,0.06)'; ctx.stroke();
      ctx.fillStyle  = 'rgba(26,115,232,0.5)';
      ctx.font       = '8px IBM Plex Mono, monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(`${a}°`, x, pad.t + ph + 13);
    });

    // -3 dB line
    const line3dB = pad.t + ph * (1 - Math.pow(10, -3 / 20));
    ctx.beginPath();
    ctx.moveTo(pad.l, line3dB); ctx.lineTo(pad.l + pw, line3dB);
    ctx.strokeStyle = 'rgba(245,158,11,0.5)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle   = 'rgba(245,158,11,0.8)';
    ctx.font        = '8px IBM Plex Mono, monospace';
    ctx.textAlign   = 'left';
    ctx.fillText('−3 dB', pad.l + 2, line3dB - 3);

    // Fill area under curve
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + ph);
    angles.forEach((angle, i) => {
      const x = pad.l + ((angle + 90) / 180) * pw;
      const y = pad.t + ph * (1 - amplitudes[i]);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.l + pw, pad.t + ph);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, 'rgba(26,115,232,0.35)');
    grad.addColorStop(1, 'rgba(26,115,232,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Profile line
    ctx.beginPath();
    angles.forEach((angle, i) => {
      const x = pad.l + ((angle + 90) / 180) * pw;
      const y = pad.t + ph * (1 - amplitudes[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Steering marker
    const sx = pad.l + ((this.arrayConfig.steeringAngle + 90) / 180) * pw;
    ctx.beginPath(); ctx.moveTo(sx, pad.t); ctx.lineTo(sx, pad.t + ph);
    ctx.strokeStyle = 'rgba(255,100,80,0.7)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  }

  /** Draws the combined IFFT time-domain waveform strip */
  private redrawTimeDomain(data: number[]): void {
    const canvasEl = this.timeDomainCanvasRef?.nativeElement;
    if (!canvasEl || !data?.length) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const W = canvasEl.width  = canvasEl.offsetWidth  || 400;
    const H = canvasEl.height = 52;
    ctx.clearRect(0, 0, W, H);

    const max = Math.max(...data.map(Math.abs), 1e-9);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H / 2 - (v / max) * (H / 2 - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 4;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  /** Draws the colourbar gradient beside the interference map */
  private drawColorbar(): void {
    const canvasEl = this.colorbarCanvasRef?.nativeElement;
    if (!canvasEl) return;
    const ctx  = canvasEl.getContext('2d');
    if (!ctx) return;
    canvasEl.width  = 16;
    canvasEl.height = 200;
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    [[0,'#ff2e63'],[0.2,'#ff9f43'],[0.45,'#ffd32a'],[0.7,'#0be881'],[0.9,'#18dcff'],[1,'#1a73e8']]
      .forEach(([t, c]) => grad.addColorStop(t as number, c as string));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 200);
  }

  // ── Animation loop (for the interference map shimmer) ─────────
  private startAnimation(): void {
    const tick = () => {
      this.animPhase += 0.02;
      // Only repaint interference if data is ready (cheap shimmer)
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.zone.runOutsideAngular(() => tick());
  }

  // ── Hover listener on interference canvas ─────────────────────
  private attachHoverListener(): void {
    const canvasEl = this.interferenceCanvasRef?.nativeElement;
    if (!canvasEl) return;

    canvasEl.addEventListener('mousemove', (ev: MouseEvent) => {
      if (!this.interferenceField) return;
      const rect = canvasEl.getBoundingClientRect();
      const px   = (ev.clientX - rect.left) / rect.width;
      const pz   = (ev.clientY - rect.top)  / rect.height;
      const { field, cols, rows, xExtentMm, zExtentMm } = this.interferenceField;
      const col  = Math.floor(px * cols);
      const row  = Math.floor(pz * rows);
      const idx  = row * cols + col;
      const amp  = (idx >= 0 && idx < field.length) ? field[idx] : 0;

      this.hoverCoords = {
        x  : (px - 0.5) * xExtentMm,
        z  : pz * zExtentMm,
        amp: +amp.toFixed(3),
      };
      this.cdr.markForCheck();
    });

    canvasEl.addEventListener('mouseleave', () => {
      this.hoverCoords = null;
      this.cdr.markForCheck();
    });
  }

  // ── Resize observer – redraws canvases when panel resizes ─────
  // ── Resize observer – redraws canvases when panel resizes ─────
private attachResizeObserver(): void {
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  this.resizeObs = new ResizeObserver((entries: ResizeObserverEntry[]) => {
    // Ignore notifications with zero-size entries (e.g. hidden panels)
    const hasSize = entries.some(
      e => e.contentRect.width > 0 && e.contentRect.height > 0
    );
    if (!hasSize) return;

    // Debounce: cancel any pending redraw and wait for the
    // browser to finish its layout pass before we paint
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizeTimer = null;

      // Run outside Angular so canvas work never triggers
      // change detection or additional layout cycles
      this.zone.runOutsideAngular(() => {
        this.redrawInterference();
        this.redrawBeamProfile();

        if (this.latestResult) {
          this.redrawTimeDomain(this.latestResult.timeDomain);
        }
      });
    }, 50); // 50 ms is enough to clear the current layout pass
  });

  const targets = [
    this.interferenceCanvasRef?.nativeElement,
    this.beamProfileCanvasRef?.nativeElement,
    this.timeDomainCanvasRef?.nativeElement,
  ];

  targets.forEach(el => {
    if (el) this.resizeObs.observe(el);
  });
}
  // ── Apodization helpers ───────────────────────────────────────
  /**
   * Returns the per-element amplitude weights for the chosen window.
   * The same weights must be passed to the backend for consistency.
   */
  apodizationWeights(n: number): number[] {
    if (n <= 1) return [1];
    const w = this.globalConfig.apodizationWindow;
    const β = this.globalConfig.kaiserBeta;
    const α = this.globalConfig.tukeyAlpha;

    return Array.from({ length: n }, (_, i) => {
      const x = i / (n - 1);   // 0 … 1
      switch (w) {
        case 'hanning' : return 0.5 * (1 - Math.cos(2 * Math.PI * x));
        case 'hamming' : return 0.54 - 0.46 * Math.cos(2 * Math.PI * x);
        case 'blackman': return 0.42 - 0.5 * Math.cos(2 * Math.PI * x)
                                      + 0.08 * Math.cos(4 * Math.PI * x);
        case 'kaiser'  : return this.besselI0(β * Math.sqrt(1 - (2 * x - 1) ** 2))
                               / this.besselI0(β);
        case 'tukey'   : {
          if (x < α / 2)       return 0.5 * (1 - Math.cos(2 * Math.PI * x / α));
          if (x > 1 - α / 2)   return 0.5 * (1 - Math.cos(2 * Math.PI * (1 - x) / α));
          return 1;
        }
        default: return 1;   // rectangular
      }
    });
  }

  /** Modified Bessel function I₀ (for Kaiser window) – series approximation */
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

  /** Noise amplitude relative to signal based on SNR setting */
  private snrNoiseFloor(): number {
    // SNR = 0   → heavy noise (σ ≈ 0.5)
    // SNR = 1000 → near-silent noise (σ ≈ 0)
    return Math.max(0, 0.5 * (1 - this.globalConfig.snr / 1000));
  }

  /**
   * BACKEND PLACEHOLDER – Synthetic IFFT time domain
   * Replace this stub with the actual IFFT result from the backend.
   * Backend should return the combined array signal in the time domain
   * after applying delays, phase shifts, apodization, and SNR noise.
   */
  private syntheticTimeDomain(): number[] {
    const N    = 256;
    const freq = this.arrayConfig.elements[0]?.frequency ?? 5;
    const snrN = this.snrNoiseFloor();
    return Array.from({ length: N }, (_, i) => {
      const t = i / N;
      return Math.exp(-((t - 0.5) ** 2) / 0.02) *
             Math.sin(2 * Math.PI * freq * t * 4)
             + snrN * (Math.random() - 0.5) * 0.3;
    });
  }

  /** HSV-inspired heatmap: blue → cyan → green → yellow → red */
  private heatmapColor(v: number): [number, number, number] {
    // Clamp
    v = Math.max(0, Math.min(1, v));
    const stops: [number, [number,number,number]][] = [
      [0.00, [  8,  20,  60]],
      [0.20, [ 24, 115, 232]],
      [0.45, [  0, 230, 160]],
      [0.70, [255, 220,  30]],
      [0.85, [255, 120,   0]],
      [1.00, [255,  30,  30]],
    ];
    for (let i = 1; i < stops.length; i++) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      if (v <= t1) {
        const t = (v - t0) / (t1 - t0);
        return [
          Math.round(c0[0] + t * (c1[0] - c0[0])),
          Math.round(c0[1] + t * (c1[1] - c0[1])),
          Math.round(c0[2] + t * (c1[2] - c0[2])),
        ];
      }
    }
    return [255, 30, 30];
  }
}