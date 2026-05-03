import {
  Component, OnDestroy, AfterViewInit, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule }  from '@angular/forms';
import { HttpClient }   from '@angular/common/http';
import { Subject, takeUntil } from 'rxjs';

import { ProbeArrayComponent } from '../probe-array/probe-array.component';
import {
  ArrayConfig, makeDefaultArrayConfig
} from '../../models/beamforming.models';

// ── Backend request shapes ────────────────────────────────────────

interface BeamSpecs {
  frequency_mhz    : number;
  num_elements     : number;
  steering_angle   : number;
  focus_depth      : number;
  element_spacing  : number;
  geometry         : 'linear' | 'curved';
  curvature_radius : number;
  apodization      : string;
  wave_speed       : number;
  snr              : number;
}

interface ElementInput {
  element_id  : string;
  label       : string;
  color       : string;
  frequency   : number;
  phase_shift : number;
  time_delay  : number;
  intensity   : number;
  enabled     : boolean;
}

// ── Backend response shape ────────────────────────────────────────

interface SimulationResponse {
  elements        : ElementInput[];
  beam_angle      : number;
  main_lobe_width : number;
  side_lobe_level : number | null;
  interference_map: string;
  beam_pattern    : number[];
  angles_deg      : number[];
}

// ── Map ArrayConfig elements → ElementInput[] ─────────────────────

function toElementInputs(cfg: ArrayConfig): ElementInput[] {
  return cfg.elements.map(e => ({
    element_id  : e.id  ?? e['id'] ?? '',
    label       : e.label       ?? '',
    color       : e.color       ?? '#3498db',
    frequency   : e.frequency   ?? 5,
    phase_shift : e.phaseShift  ?? e['phaseShift'] ?? 0,
    time_delay  : e.timeDelay   ?? e['timeDelay']  ?? 0,
    intensity   : e.intensity   ?? 100,
    enabled     : e.enabled     ?? true,
  }));
}

@Component({
  selector       : 'app-beam-builder',
  standalone     : true,
  imports        : [CommonModule, FormsModule, ProbeArrayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './beam-builder.component.html',
  styleUrls      : ['./beam-builder.component.css'],
})
export class BeamBuilderComponent implements AfterViewInit, OnDestroy {

  @ViewChild('polarCanvas') polarCanvasRef!: ElementRef<HTMLCanvasElement>;

  readonly API = 'http://localhost:8000/simulate';

  mode: 'specs' | 'elements' = 'specs';

  // ── Option 1 state ────────────────────────────────────────────
  specs: BeamSpecs = {
    frequency_mhz    : 5,
    num_elements     : 8,
    steering_angle   : 0,
    focus_depth      : 80,
    element_spacing  : 0.5,
    geometry         : 'linear',
    curvature_radius : 50,
    apodization      : 'hanning',
    wave_speed       : 1.54,
    snr              : 60,
  };

  // ── Option 2 state: full ArrayConfig drives ProbeArrayComponent ─
  elemArrayConfig: ArrayConfig = makeDefaultArrayConfig(4);

  // Array-level config for the elements tab
  elemGeometry       : 'linear' | 'curved' = 'linear';
  elemCurvatureRadius: number = 50;
  elemSpacing        : number = 0.5;
  elemFocus          : number = 0;
  elemSteering       : number = 0;

  // ── Result state ──────────────────────────────────────────────
  interferenceMap : string | null = null;
  beamAngle       : number | null = null;
  mainLobeWidth   : number | null = null;
  sideLobeLevel   : number | null = null;
  hasResult       : boolean = false;

  private beamPattern  : number[] = [];
  private anglesDeg    : number[] = [];
  private steeringAngle: number   = 0;

  loading: boolean = false;
  error  : string  = '';

  private destroy$  = new Subject<void>();
  private resizeObs!: ResizeObserver;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.attachResizeObserver();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObs?.disconnect();
  }

  // ── ProbeArray event handlers ─────────────────────────────────

  onElemArrayConfigChange(cfg: ArrayConfig): void {
    this.elemArrayConfig = cfg;
    // Sync local controls to reflect any changes made inside the probe component
    this.elemSteering        = cfg.steeringAngle   ?? this.elemSteering;
    this.elemFocus           = cfg.focusDepth       ?? this.elemFocus;
    this.elemSpacing         = cfg.elementSpacing   ?? this.elemSpacing;
    this.elemGeometry        = (cfg.geometry as any) ?? this.elemGeometry;
    this.elemCurvatureRadius = cfg.curvatureRadius  ?? this.elemCurvatureRadius;
    this.cdr.markForCheck();
  }

  // ── Array-level config controls → push into ProbeArrayComponent ─

  applyElemArrayConfig(): void {
    this.elemArrayConfig = {
      ...this.elemArrayConfig,
      steeringAngle   : this.elemSteering,
      focusDepth      : this.elemFocus,
      elementSpacing  : this.elemSpacing,
      geometry        : this.elemGeometry,
      curvatureRadius : this.elemCurvatureRadius,
    };
    this.cdr.markForCheck();
  }

  // ── Submits ───────────────────────────────────────────────────

  submitSpecs(): void {
    this.steeringAngle = this.specs.steering_angle;
    this.call(
      this.http.post<SimulationResponse>(`${this.API}/from-beam-specs`, this.specs)
    );
  }

  submitElements(): void {
    this.steeringAngle = this.elemArrayConfig.steeringAngle ?? 0;
    const body = toElementInputs(this.elemArrayConfig);
    this.call(
      this.http.post<SimulationResponse>(
        `${this.API}/from-elements`,
        body,
        { params: {
            steering_angle: String(this.elemArrayConfig.steeringAngle ?? 0),
            focus_depth   : String(this.elemArrayConfig.focusDepth    ?? 0),
        }},
      )
    );
  }

  // ── Internal ──────────────────────────────────────────────────

  private call(obs: ReturnType<HttpClient['post']>): void {
    this.loading = true;
    this.error   = '';
    this.cdr.markForCheck();

    (obs as any).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res: SimulationResponse) => {
        this.interferenceMap = res.interference_map ?? null;
        this.beamAngle       = res.beam_angle       ?? null;
        this.mainLobeWidth   = res.main_lobe_width  ?? null;
        this.sideLobeLevel   = res.side_lobe_level  ?? null;
        this.beamPattern     = res.beam_pattern     ?? [];
        this.anglesDeg       = res.angles_deg       ?? [];
        this.hasResult       = true;
        this.loading         = false;
        this.cdr.detectChanges();
        setTimeout(() => this.drawPolar(), 0);
      },
      error: (err: any) => {
        this.error   = err?.error?.detail ?? err?.message ?? 'Request failed';
        this.loading = false;
        this.cdr.detectChanges();
      },
    });
  }

  // ── Polar canvas renderer ─────────────────────────────────────

  private drawPolar(): void {
    const canvasEl = this.polarCanvasRef?.nativeElement;
    if (!canvasEl || !this.beamPattern.length) return;

    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const W = canvasEl.width  = canvasEl.offsetWidth  || 400;
    const H = canvasEl.height = canvasEl.offsetHeight || 400;

    ctx.clearRect(0, 0, W, H);

    const cx     = W / 2;
    const cy     = H / 2 + 20;
    const radius = Math.min(W, H) / 2 - 28;

    const DB_FLOOR = -40;
    const norm = this.beamPattern.map(db =>
      Math.max(0, Math.min(1, (Math.max(db, DB_FLOOR) - DB_FLOOR) / (-DB_FLOOR)))
    );

    // Grid rings
    [10, 20, 30, 40].forEach(dbDown => {
      const r = radius * (1 - dbDown / 40);
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, 0);
      ctx.strokeStyle = `rgba(26,115,232,${0.08 + (40 - dbDown) / 40 * 0.12})`;
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.fillStyle  = 'rgba(26,115,232,0.45)';
      ctx.font       = '8px IBM Plex Mono, monospace';
      ctx.textAlign  = 'left';
      ctx.fillText(`-${dbDown}`, cx + r + 2, cy - 2);
    });

    // Spokes
    [-90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90].forEach(a => {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
      ctx.strokeStyle = 'rgba(26,115,232,0.07)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      const lx = cx + (radius + 14) * Math.cos(rad);
      const ly = cy + (radius + 14) * Math.sin(rad);
      ctx.fillStyle = 'rgba(26,115,232,0.55)';
      ctx.font      = '8px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${a}°`, lx, ly + 3);
    });

    // Fill
    ctx.beginPath();
    let first = true;
    this.anglesDeg.forEach((angle, i) => {
      const r   = norm[i] * radius;
      const rad = ((angle - 90) * Math.PI) / 180;
      const px  = cx + r * Math.cos(rad);
      const py  = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; }
      else          ctx.lineTo(px, py);
    });
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, 'rgba(26,115,232,0.45)');
    grad.addColorStop(1, 'rgba(26,115,232,0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Stroke
    ctx.beginPath();
    first = true;
    this.anglesDeg.forEach((angle, i) => {
      const r   = norm[i] * radius;
      const rad = ((angle - 90) * Math.PI) / 180;
      const px  = cx + r * Math.cos(rad);
      const py  = cy + r * Math.sin(rad);
      if (first) { ctx.moveTo(px, py); first = false; }
      else          ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth   = 1.8;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Steering marker
    const steerRad = ((this.steeringAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * 1.05 * Math.cos(steerRad), cy + radius * 1.05 * Math.sin(steerRad));
    ctx.strokeStyle = 'rgba(255,100,80,0.8)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Resize observer ───────────────────────────────────────────

  private attachResizeObserver(): void {
    this.resizeObs = new ResizeObserver(() => {
      if (this.hasResult) this.drawPolar();
    });
    const el = this.polarCanvasRef?.nativeElement;
    if (el) this.resizeObs.observe(el);
  }
}