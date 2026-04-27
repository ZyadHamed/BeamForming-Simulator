import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

import {
  ArrayConfig, ScenarioPreset,
  PREDEFINED_SCENARIOS, makeDefaultArrayConfig,
} from '../../../models/beamforming.models';

/* ── backend DTOs ─────────────────────────────────────────────── */

interface TissueRegionSpec {
  name: string; center_x: number; center_z: number;
  semi_axis_x: number; semi_axis_z: number; rotation_deg: number;
  speed_of_sound: number; attenuation_db_per_cm_mhz: number;
  density_kg_m3: number; is_fluid: boolean;
}

interface ProbeSpec {
  num_elements: number; pitch_mm: number; frequency_mhz: number;
  focus_depth_mm: number; speed_of_sound_mm_us: number;
  snr_db: number; apodization_window: string; geometry: string;
}

interface CreateScenarioReq {
  session_id: string; probe: ProbeSpec;
  use_shepp_logan: boolean; shepp_logan_scale_mm: number;
  phantom_spec?: {
    regions: TissueRegionSpec[]; n_boundary: number;
    grid_spacing_mm: number; noise_density: number;
    seed: number; z_offset_mm: number; max_scatterers: number;
  };
}
interface CreateScenarioRes { session_id: string; num_scatterers: number; message: string; }

interface AModeReq { session_id: string; angle_deg: number; max_depth_mm: number; }
interface AModeRes { angle_deg: number; depths_mm: number[]; amplitudes: number[]; }

interface BModeReq { session_id: string; start_angle: number; end_angle: number; num_lines: number; max_depth_mm: number; }
interface BModeRes { sector_angles_deg: number[]; axial_depths_mm: number[]; image_grid: number[][]; }

interface VesselSpec {
  start_x_mm: number; start_z_mm: number;
  direction_x: number; direction_z: number;
  radius_mm: number; velocity_magnitude_mms: number;
  num_blood_cells: number; background_noise: number;
}
interface CreateVesselReq { session_id: string; probe: ProbeSpec; vessel_spec: VesselSpec; }
interface CreateVesselRes { session_id: string; num_scatterers: number; message: string; }

interface DopplerLineRes  { angle_deg: number; depths_mm: number[]; velocities_ms: number[]; power: number[]; }
interface ColorDopplerRes { sector_angles_deg: number[]; axial_depths_mm: number[]; velocity_grid: number[][]; power_grid: number[][]; }

/* ── local helpers ────────────────────────────────────────────── */

interface PhantomRegion extends TissueRegionSpec { hovered: boolean; editing: boolean; }
type ScanMode = 'a-mode' | 'b-mode' | 'doppler';

const SCALE = 60;

function defaultRegions(): PhantomRegion[] {
  const s = SCALE / 2;
  const r = (name: string, cx: number, cz: number, sx: number, sz: number,
             rot: number, c: number, att: number, rho: number, fl: boolean): PhantomRegion =>
    ({ name, center_x: cx, center_z: cz, semi_axis_x: sx, semi_axis_z: sz,
       rotation_deg: rot, speed_of_sound: c, attenuation_db_per_cm_mhz: att,
       density_kg_m3: rho, is_fluid: fl, hovered: false, editing: false });
  return [
    r('Body Wall',              0,      0,         s*.92, s*.69,   0, 1540, 0.5,  1060, false),
    r('Liver Parenchyma',       0,      s*-.0184,  s*.874,s*.6624, 0, 1570, 0.5,  1060, false),
    r('Hyperechoic Lesion (R)', s*-.31, s*-.22,    s*.31, s*.11, -18, 1560, 0.6,  1040, false),
    r('Hyperechoic Lesion (L)', s*.31,  s*-.22,    s*.31, s*.11,  18, 1560, 0.6,  1040, false),
    r('Gallbladder (Cyst)',     0,      s*-.35,    s*.25, s*.21,   0, 1480, 0.002,1000, true),
    r('Nodule A',               s*-.22, 0,         s*.046,s*.046,  0, 1550, 0.7,  1050, false),
    r('Nodule B',               s*.22,  0,         s*.046,s*.046,  0, 1550, 0.7,  1050, false),
    r('Fat Layer',              0,      s*-.605,   s*.046,s*.023,  0, 1450, 0.5,   950, false),
    r('Vessel Wall',            0,      s*-.605,   s*.023,s*.023,-90, 1580, 1.0,  1070, false),
    r('Dense Structure (Bone)', 0,      s*.605,    s*.046,s*.023,  0, 3500,10.0,  1900, false),
  ];
}

const REGION_STROKE = ['#e8b4b4','#d4c4a8','#b4c8e8','#c8e8b4','#e8d4b4','#b4e8d4','#d4b4e8','#e8e4b4','#b4b4e8','#c8c8c8'];
const REGION_FILL   = [
  'rgba(232,180,180,.35)','rgba(212,196,168,.30)','rgba(180,200,232,.35)',
  'rgba(200,232,180,.30)','rgba(232,212,180,.25)','rgba(180,232,212,.30)',
  'rgba(212,180,232,.30)','rgba(232,228,180,.25)','rgba(180,180,232,.30)',
  'rgba(200,200,200,.20)',
];

@Component({
  selector: 'app-mode-ultrasound',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-ultrasound.component.html',
  styleUrls: ['./mode-ultrasound.component.css'],
})
export class ModeUltrasoundComponent implements OnInit, OnDestroy {

  // Left-panel canvases — mutually exclusive by mode
  @ViewChild('phantomCanvas', { static: false }) phantomRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('vesselCanvas',  { static: false }) vesselRef!:  ElementRef<HTMLCanvasElement>;
  // Right-panel result canvases
  @ViewChild('amodeCanvas',   { static: false }) amodeRef!:   ElementRef<HTMLCanvasElement>;
  @ViewChild('bmodeCanvas',   { static: false }) bmodeRef!:   ElementRef<HTMLCanvasElement>;
  @ViewChild('dopplerCanvas', { static: false }) dopplerRef!: ElementRef<HTMLCanvasElement>;

  private api = 'http://localhost:8000';

  /* ── sessions (completely independent) ─────────────────────── */
  sessionId       = 'us_'  + Math.random().toString(36).slice(2, 8);
  vesselSessionId = 'dop_' + Math.random().toString(36).slice(2, 8);
  scenarioReady   = false;
  vesselReady     = false;
  numScatterers   = 0;

  arrayConfig: ArrayConfig = makeDefaultArrayConfig(32);
  selectedPreset  = '';
  ultrasoundPresets: ScenarioPreset[] = PREDEFINED_SCENARIOS.filter(s => s.mode === 'ultrasound');

  scanMode: ScanMode = 'b-mode';

  /* ── Shepp-Logan phantom ────────────────────────────────────── */
  phantomScale  = SCALE;
  regions: PhantomRegion[] = defaultRegions();
  hoveredRegion: PhantomRegion | null = null;
  editingRegion: PhantomRegion | null = null;
  tooltipX = 0; tooltipY = 0;

  probeAngle = 0;   // position around outer ellipse (deg, 0 = top)
  beamSteer  = 0;   // steering offset from probe normal (deg, ±45)
  private probeDrag = false;
  private beamDrag  = false;

  /* ── shared probe spec ──────────────────────────────────────── */
  probe: ProbeSpec = {
    num_elements: 32, pitch_mm: .2, frequency_mhz: 5,
    focus_depth_mm: 40, speed_of_sound_mm_us: 1.54,
    snr_db: 50, apodization_window: 'hamming', geometry: 'linear',
  };

  /* ── A/B-mode params ────────────────────────────────────────── */
  bStart = -30; bEnd = 30; bLines = 48; bDepth = 80;

  /* ── Vessel / Doppler params ────────────────────────────────────
   *  Coordinates are in the VESSEL SESSION's own space.
   *  Think of it as a standalone tube phantom: probe face at z = 0,
   *  depth increases downward.  Nothing to do with the Shepp-Logan.
   * ─────────────────────────────────────────────────────────── */
  vStartX =  0;   // vessel centreline midpoint X (mm)
  vStartZ = 30;   // vessel centreline midpoint Z — at a good scan depth
  vDirX   =  1;   // flow direction vector (normalised by backend)
  vDirZ   =  0;   // purely horizontal by default
  vRadius =  4;   // lumen radius (mm)
  vVel    = 150;  // peak velocity (mm/s)
  vCells  = 300;

  dPrf = 4000; dPkt = 8; dDepth = 70;
  dAngle = 0; dLines = 32; dStart = -25; dEnd = 25;
  dopplerMode: 'line' | 'color' = 'color';

  /* ── results ────────────────────────────────────────────────── */
  amodeData:    AModeRes        | null = null;
  bmodeData:    BModeRes        | null = null;
  dLineData:    DopplerLineRes  | null = null;
  cDopplerData: ColorDopplerRes | null = null;

  loading = false; loadMsg = ''; errMsg = '';

  private anim = 0; private t = 0;
  // phantom→canvas mapping (updated every draw frame)
  private pCx = 0; private pCz = 0; private pScale = 1;

  constructor(private cdr: ChangeDetectorRef, private http: HttpClient) {}

  ngOnInit()    { this.startAnim(); this.createScenario(); }
  ngOnDestroy() { cancelAnimationFrame(this.anim); }

  // ── phantom scenario ─────────────────────────────────────────
  createScenario() {
    this.setLoading('Creating phantom scenario…');
    this.scenarioReady = false;
    this.sessionId = 'us_' + Math.random().toString(36).slice(2, 8);
    this.http.post<CreateScenarioRes>(`${this.api}/scenario/create`, {
      session_id: this.sessionId, probe: { ...this.probe },
      use_shepp_logan: true, shepp_logan_scale_mm: this.phantomScale,
    } as CreateScenarioReq).subscribe({
      next: r => { this.scenarioReady = true; this.numScatterers = r.num_scatterers; this.clearLoading(); },
      error: e => this.setError(e),
    });
  }

  createCustomScenario() {
    this.setLoading('Recreating with edited regions…');
    this.scenarioReady = false;
    this.sessionId = 'us_' + Math.random().toString(36).slice(2, 8);
    const regs: TissueRegionSpec[] = this.regions.map(({ hovered, editing, ...r }) => r);
    this.http.post<CreateScenarioRes>(`${this.api}/scenario/create`, {
      session_id: this.sessionId, probe: { ...this.probe },
      use_shepp_logan: false, shepp_logan_scale_mm: this.phantomScale,
      phantom_spec: { regions: regs, n_boundary: 50, grid_spacing_mm: 2,
        noise_density: .05, seed: 42, z_offset_mm: this.phantomScale / 2, max_scatterers: 5000 },
    } as CreateScenarioReq).subscribe({
      next: r => { this.scenarioReady = true; this.numScatterers = r.num_scatterers; this.clearLoading(); },
      error: e => this.setError(e),
    });
  }

  // ── vessel scenario (independent) ────────────────────────────
  createVesselScenario() {
    this.setLoading('Creating vessel scenario…');
    this.vesselReady = false;
    this.vesselSessionId = 'dop_' + Math.random().toString(36).slice(2, 8);
    this.http.post<CreateVesselRes>(`${this.api}/scenario/create_vessel`, {
      session_id: this.vesselSessionId,
      probe: { ...this.probe },
      vessel_spec: {
        start_x_mm: this.vStartX, start_z_mm: this.vStartZ,
        direction_x: this.vDirX,  direction_z: this.vDirZ,
        radius_mm: this.vRadius,
        velocity_magnitude_mms: this.vVel,
        num_blood_cells: this.vCells,
        background_noise: 0.01,
      } as VesselSpec,
    } as CreateVesselReq).subscribe({
      next: () => { 
        this.vesselReady = true; 
        this.clearLoading();
        this.cdr.detectChanges();},
      error: e => this.setError(e),
    });
  }

  // ── scans ─────────────────────────────────────────────────────
runScan() {
  if (this.scanMode === 'a-mode')  return this.runAMode();
  if (this.scanMode === 'b-mode')  return this.runBMode();
  if (this.scanMode === 'doppler') {
    this.cdr.detectChanges();   // <-- ADD (ensure Doppler canvas exists in DOM before drawing)
    return this.dopplerMode === 'line' ? this.runDopplerLine() : this.runColorDoppler();
  }
}

  private runAMode() {
    if (!this.scenarioReady) { this.errMsg = 'Create scenario first'; this.cdr.markForCheck(); return; }
    this.setLoading('A-mode scan…');
    this.http.post<AModeRes>(`${this.api}/scan/amode`, {
      session_id: this.sessionId,
      angle_deg:  this.probeAngle + this.beamSteer,   // absolute global angle
      max_depth_mm: this.bDepth,
    } as AModeReq).subscribe({
      next: r => { this.amodeData = r; this.clearLoading(); this.drawAMode(); },
      error: e => this.setError(e),
    });
  }

  private runBMode() {
    if (!this.scenarioReady) { this.errMsg = 'Create scenario first'; this.cdr.markForCheck(); return; }
    this.setLoading('B-mode sweep…');
    this.http.post<BModeRes>(`${this.api}/scan/bmode`, {
      session_id:   this.sessionId,
      start_angle:  this.probeAngle + this.bStart,
      end_angle:    this.probeAngle + this.bEnd,
      num_lines:    this.bLines,
      max_depth_mm: this.bDepth,
    } as BModeReq).subscribe({
      next: r => { this.bmodeData = r; this.clearLoading(); this.drawBMode(); },
      error: e => this.setError(e),
    });
  }

  private runDopplerLine() {
    if (!this.vesselReady) { this.errMsg = 'Create vessel first'; this.cdr.markForCheck(); return; }
    this.setLoading('Doppler line…');
    this.http.post<DopplerLineRes>(`${this.api}/scan/doppler_line`, {
      session_id:   this.vesselSessionId,
      angle_deg:    this.dAngle,
      max_depth_mm: this.dDepth,
      prf_hz:       this.dPrf,
      packet_size:  this.dPkt,
    }).subscribe({
      next: r => { 
        this.dLineData = r; 
        this.clearLoading(); 
        this.drawDoppler();
      this.cdr.detectChanges(); 
    },
      error: e => this.setError(e),
    });
  }

  private runColorDoppler() {
    if (!this.vesselReady) { this.errMsg = 'Create vessel first'; this.cdr.markForCheck(); return; }
    this.setLoading('Color Doppler…');
    this.http.post<ColorDopplerRes>(`${this.api}/scan/color_doppler`, {
      session_id:   this.vesselSessionId,
      start_angle:  this.dStart,
      end_angle:    this.dEnd,
      num_lines:    this.dLines,
      max_depth_mm: this.dDepth,
      prf_hz:       this.dPrf,
      packet_size:  this.dPkt,
    }).subscribe({
      next: r => { 
        this.cDopplerData = r; 
        this.clearLoading(); 
        this.drawDoppler(); 
      this.cdr.detectChanges();
      },
      error: e => this.setError(e),
    });
  }

  private setLoading(m: string) { this.loading = true; this.loadMsg = m; this.errMsg = ''; this.cdr.markForCheck(); }
  private clearLoading()        { this.loading = false; this.loadMsg = ''; this.cdr.markForCheck(); }
  private setError(e: any)      { this.loading = false; this.errMsg = e?.error?.detail || 'Request failed'; this.cdr.markForCheck(); }

  // ── phantom interaction ───────────────────────────────────────
  onPhantomMove(ev: MouseEvent) {
    const c = this.phantomRef?.nativeElement; if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const mmX = (mx - this.pCx) / this.pScale, mmZ = (my - this.pCz) / this.pScale;

    if (this.probeDrag) {
      const o = this.regions[0];
      this.probeAngle = Math.atan2(mmX - o.center_x, -(mmZ - o.center_z)) * 180 / Math.PI;
      this.cdr.markForCheck(); return;
    }
    if (this.beamDrag) {
      const p = this.probePos();
      const global = Math.atan2(mmX - p.x, mmZ - p.z) * 180 / Math.PI;
      this.beamSteer = Math.max(-45, Math.min(45, global - this.probeAngle));
      this.cdr.markForCheck(); return;
    }

    this.regions.forEach(r => r.hovered = false);
    let hit: PhantomRegion | null = null;
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (this.ptInRegion(mmX, mmZ, this.regions[i])) { hit = this.regions[i]; break; }
    }
    if (hit) { hit.hovered = true; this.hoveredRegion = hit; this.tooltipX = mx + 14; this.tooltipY = my - 8; }
    else      { this.hoveredRegion = null; }
    this.cdr.markForCheck();
  }

  onPhantomDown(ev: MouseEvent) {
    const c = this.phantomRef?.nativeElement; if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const mmX = (mx - this.pCx) / this.pScale, mmZ = (my - this.pCz) / this.pScale;
    const p   = this.probePos();
    const ppx = this.pCx + p.x * this.pScale, ppz = this.pCz + p.z * this.pScale;

    if (Math.hypot(mx - ppx, my - ppz) < 18) { this.probeDrag = true; ev.preventDefault(); return; }
    const hb = this.beamHandlePos(20);
    if (Math.hypot(mx - (this.pCx + hb.x * this.pScale), my - (this.pCz + hb.z * this.pScale)) < 14) {
      this.beamDrag = true; ev.preventDefault(); return;
    }
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (this.ptInRegion(mmX, mmZ, this.regions[i])) {
        this.editingRegion = this.regions[i]; this.editingRegion.editing = true;
        this.cdr.markForCheck(); return;
      }
    }
  }

  onPhantomUp()    { this.probeDrag = false; this.beamDrag = false; }
  onPhantomLeave() {
    this.probeDrag = false; this.beamDrag = false;
    this.hoveredRegion = null; this.regions.forEach(r => r.hovered = false);
    this.cdr.markForCheck();
  }

  closeEditor() { if (this.editingRegion) { this.editingRegion.editing = false; this.editingRegion = null; } this.cdr.markForCheck(); }
  applyEdit()   { this.closeEditor(); this.createCustomScenario(); }

  private ptInRegion(x: number, z: number, r: PhantomRegion): boolean {
    const c = Math.cos(-r.rotation_deg * Math.PI / 180), s = Math.sin(-r.rotation_deg * Math.PI / 180);
    const dx = x - r.center_x, dz = z - r.center_z;
    const rx = dx * c - dz * s, rz = dx * s + dz * c;
    return (rx / r.semi_axis_x) ** 2 + (rz / r.semi_axis_z) ** 2 <= 1;
  }

  probePos(): { x: number; z: number } {
    const o = this.regions[0]; if (!o) return { x: 0, z: -30 };
    const a = this.probeAngle * Math.PI / 180;
    return { x: o.center_x + o.semi_axis_x * Math.sin(a), z: o.center_z - o.semi_axis_z * Math.cos(a) };
  }

  private beamHandlePos(len: number) {
    const p = this.probePos(), a = (this.probeAngle + this.beamSteer) * Math.PI / 180;
    return { x: p.x + len * Math.sin(a), z: p.z + len * Math.cos(a) };
  }

  loadPreset(name: string) {
    const p = this.ultrasoundPresets.find(x => x.name === name); if (!p) return;
    this.arrayConfig = { ...p.array }; this.cdr.markForCheck();
  }

  // ── animation loop ────────────────────────────────────────────
  private startAnim() {
    const loop = () => {
      this.t += .025;
      this.drawPhantom();
      if (this.scanMode === 'doppler') this.drawVesselSchematic();
      this.anim = requestAnimationFrame(loop);
    };
    loop();
  }

  // ════════════════════════════════════════════════════════════
  //  DRAWING: Shepp-Logan Phantom  (left panel for A & B mode)
  // ════════════════════════════════════════════════════════════
  private drawPhantom() {
    const cv = this.phantomRef?.nativeElement; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width = cv.offsetWidth || 500, H = cv.height = cv.offsetHeight || 400;
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H)/2);
    bg.addColorStop(0, '#1a1e2e'); bg.addColorStop(1, '#0e1118');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    const o = this.regions[0]; if (!o) return;
    const scX = (W - 60) / (o.semi_axis_x * 2.4), scZ = (H - 80) / (o.semi_axis_z * 2.4);
    this.pScale = Math.min(scX, scZ);
    this.pCx = W/2 - o.center_x * this.pScale;
    this.pCz = H/2 - o.center_z * this.pScale;
    const tx = (mm: number) => this.pCx + mm * this.pScale;
    const tz = (mm: number) => this.pCz + mm * this.pScale;

    ctx.strokeStyle = 'rgba(100,120,160,.08)'; ctx.lineWidth = .5;
    for (let mm = -60; mm <= 60; mm += 10) {
      ctx.beginPath(); ctx.moveTo(tx(mm), 0); ctx.lineTo(tx(mm), H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, tz(mm)); ctx.lineTo(W, tz(mm)); ctx.stroke();
    }

    this.regions.forEach((r, i) => {
      ctx.save();
      ctx.translate(tx(r.center_x), tz(r.center_z));
      ctx.rotate(r.rotation_deg * Math.PI / 180);
      ctx.beginPath();
      ctx.ellipse(0, 0, r.semi_axis_x * this.pScale, r.semi_axis_z * this.pScale, 0, 0, Math.PI * 2);
      ctx.fillStyle = r.is_fluid
        ? (r.hovered ? 'rgba(40,40,60,.7)' : 'rgba(20,20,30,.6)')
        : (r.hovered ? REGION_FILL[i % REGION_FILL.length].replace(/[\d.]+\)$/, '.55)') : REGION_FILL[i % REGION_FILL.length]);
      ctx.fill();
      ctx.strokeStyle = r.editing ? '#ffd700' : r.hovered ? '#fff' : REGION_STROKE[i % REGION_STROKE.length];
      ctx.lineWidth = r.hovered || r.editing ? 2 : 1; ctx.stroke();
      if (r.semi_axis_x * this.pScale > 22 && r.semi_axis_z * this.pScale > 14) {
        ctx.fillStyle = r.hovered ? 'rgba(255,255,255,.9)' : 'rgba(200,210,220,.5)';
        ctx.font = '9px IBM Plex Mono,monospace'; ctx.textAlign = 'center'; ctx.fillText(r.name, 0, 4);
      }
      ctx.restore();
    });

    // probe
    const pp = this.probePos(), ppx = tx(pp.x), ppz = tz(pp.z);
    ctx.save(); ctx.translate(ppx, ppz); ctx.rotate(this.probeAngle * Math.PI / 180);
    ctx.fillStyle = '#2a3a5a'; ctx.strokeStyle = '#5a8ade'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-13, -20, 26, 13, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4a9eff'; ctx.fillRect(-11, -7, 22, 3);
    ctx.fillStyle = '#8ab4ff'; ctx.font = '7px IBM Plex Mono,monospace'; ctx.textAlign = 'center'; ctx.fillText('PROBE', 0, -10);
    const pulse = .5 + .5 * Math.sin(this.t * 6);
    ctx.strokeStyle = `rgba(74,158,255,${(.3 * pulse).toFixed(2)})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, -5, 6 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // sector cone (B-mode)
    if (this.scanMode === 'b-mode') {
      const a1 = (this.probeAngle + this.bStart) * Math.PI / 180;
      const a2 = (this.probeAngle + this.bEnd)   * Math.PI / 180;
      const cl  = this.bDepth * .7;
      ctx.beginPath(); ctx.moveTo(ppx, ppz);
      ctx.lineTo(tx(pp.x + cl * Math.sin(a1)), tz(pp.z + cl * Math.cos(a1)));
      ctx.lineTo(tx(pp.x + cl * Math.sin(a2)), tz(pp.z + cl * Math.cos(a2)));
      ctx.closePath(); ctx.fillStyle = 'rgba(74,158,255,.06)'; ctx.fill();
      ctx.strokeStyle = 'rgba(74,158,255,.2)'; ctx.lineWidth = .5; ctx.stroke();
    }

    // beam line
    const totalRad = (this.probeAngle + this.beamSteer) * Math.PI / 180;
    const ex = pp.x + this.bDepth * Math.sin(totalRad), ez = pp.z + this.bDepth * Math.cos(totalRad);
    ctx.beginPath(); ctx.setLineDash([4, 4]);
    ctx.strokeStyle = this.scanMode === 'a-mode' ? 'rgba(255,200,0,.7)' : 'rgba(74,158,255,.5)';
    ctx.lineWidth = 1.5; ctx.moveTo(ppx, ppz); ctx.lineTo(tx(ex), tz(ez));
    ctx.stroke(); ctx.setLineDash([]);

    // beam drag handle
    const hb = this.beamHandlePos(20), hpx = tx(hb.x), hpz = tz(hb.z);
    ctx.beginPath(); ctx.arc(hpx, hpz, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,200,0,.7)'; ctx.fill();
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,100,.8)'; ctx.font = '9px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(`steer ${this.beamSteer.toFixed(1)}°  →  ${(this.probeAngle + this.beamSteer).toFixed(1)}° abs`, hpx + 10, hpz + 3);

    // scale bar
    ctx.fillStyle = 'rgba(150,160,180,.5)'; ctx.font = '9px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    const sb = 10 * this.pScale;
    ctx.fillRect(W - 20 - sb, H - 20, sb, 2);
    ctx.fillText('10 mm', W - 20 - sb, H - 24);
  }

  // ════════════════════════════════════════════════════════════
  //  DRAWING: Vessel schematic  (left panel for Doppler mode)
  //
  //  This is an entirely separate scene — just the vessel tube
  //  floating in a uniform medium, with probe at z=0.
  //  Nothing here is drawn on or near the Shepp-Logan phantom.
  // ════════════════════════════════════════════════════════════
  private drawVesselSchematic() {
    const cv = this.vesselRef?.nativeElement; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width = cv.offsetWidth || 500, H = cv.height = cv.offsetHeight || 400;
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H)/2);
    bg.addColorStop(0, '#0f1520'); bg.addColorStop(1, '#080c14');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // coordinate mapping: show ±50 mm horizontally, 0 → dDepth+10 vertically
    const viewHalfX = 50;
    const sc = Math.min((W - 60) / (viewHalfX * 2), (H - 60) / (this.dDepth + 10));
    const originX = W / 2, originY = 30;                 // canvas coords of (0,0) in mm space
    const tx = (mm: number) => originX + mm * sc;
    const tz = (mm: number) => originY + mm * sc;

    // grid
    ctx.strokeStyle = 'rgba(60,90,130,.15)'; ctx.lineWidth = .5;
    for (let x = -50; x <= 50; x += 10) { ctx.beginPath(); ctx.moveTo(tx(x), 0); ctx.lineTo(tx(x), H); ctx.stroke(); }
    for (let z = 0; z <= this.dDepth + 10; z += 10) { ctx.beginPath(); ctx.moveTo(0, tz(z)); ctx.lineTo(W, tz(z)); ctx.stroke(); }

    // axis labels
    ctx.fillStyle = 'rgba(100,130,170,.4)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'right';
    for (let z = 0; z <= this.dDepth; z += 10)
      ctx.fillText(`${z} mm`, originX - viewHalfX * sc - 2, tz(z) + 3);

    // ── probe face at z = 0 ──────────────────────────────────
    ctx.fillStyle = '#2a3a5a'; ctx.strokeStyle = '#5a8ade'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(tx(-14), tz(-8), 28, 8, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4a9eff'; ctx.fillRect(tx(-12), tz(0) - 3, 24, 3);
    ctx.fillStyle = '#8ab4ff'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText('PROBE', tx(0), tz(-4));

    // ── scan sector / line ───────────────────────────────────
    if (this.dopplerMode === 'color') {
      const a1 = this.dStart * Math.PI / 180, a2 = this.dEnd * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(tx(0), tz(0));
      ctx.lineTo(tx(this.dDepth * Math.sin(a1)), tz(this.dDepth * Math.cos(a1)));
      ctx.lineTo(tx(this.dDepth * Math.sin(a2)), tz(this.dDepth * Math.cos(a2)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,80,80,.05)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,80,80,.2)'; ctx.lineWidth = .5; ctx.stroke();
    } else {
      const a = this.dAngle * Math.PI / 180;
      ctx.beginPath(); ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,80,80,.45)'; ctx.lineWidth = 1;
      ctx.moveTo(tx(0), tz(0));
      ctx.lineTo(tx(this.dDepth * Math.sin(a)), tz(this.dDepth * Math.cos(a)));
      ctx.stroke(); ctx.setLineDash([]);
    }

    // ── vessel tube ──────────────────────────────────────────
    const mag  = Math.hypot(this.vDirX, this.vDirZ) || 1;
    const ndx  = this.vDirX / mag, ndz = this.vDirZ / mag;  // unit flow vector
    const perpX = -ndz, perpZ = ndx;                         // unit perpendicular
    const half  = 50;                                         // half-length drawn (mm)

    const x1 = this.vStartX - ndx * half, z1 = this.vStartZ - ndz * half;
    const x2 = this.vStartX + ndx * half, z2 = this.vStartZ + ndz * half;

    // lumen fill
    ctx.beginPath();
    ctx.moveTo(tx(x1 + perpX * this.vRadius), tz(z1 + perpZ * this.vRadius));
    ctx.lineTo(tx(x2 + perpX * this.vRadius), tz(z2 + perpZ * this.vRadius));
    ctx.lineTo(tx(x2 - perpX * this.vRadius), tz(z2 - perpZ * this.vRadius));
    ctx.lineTo(tx(x1 - perpX * this.vRadius), tz(z1 - perpZ * this.vRadius));
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,5,5,.85)'; ctx.fill();

    // vessel walls
    [1, -1].forEach(sign => {
      ctx.beginPath();
      ctx.moveTo(tx(x1 + perpX * this.vRadius * sign), tz(z1 + perpZ * this.vRadius * sign));
      ctx.lineTo(tx(x2 + perpX * this.vRadius * sign), tz(z2 + perpZ * this.vRadius * sign));
      ctx.strokeStyle = 'rgba(200,70,70,.9)'; ctx.lineWidth = 2; ctx.stroke();
    });

    // animated blood-cell dots (deterministic, phase-shifted per index)
    const numDots = 20;
    for (let i = 0; i < numDots; i++) {
      const phase  = ((i / numDots) + this.t * 0.07 * Math.sign(this.vVel || 1)) % 1;
      const along  = (phase * 2 - 1) * half;                     // −half … +half along centreline
      const latOff = Math.sin(i * 2.3999632) * this.vRadius * 0.7; // deterministic lateral spread
      const dotX   = this.vStartX + ndx * along + perpX * latOff;
      const dotZ   = this.vStartZ + ndz * along + perpZ * latOff;
      const alpha  = 0.35 + 0.45 * Math.abs(Math.sin(i * 1.3 + this.t * 2));
      ctx.beginPath(); ctx.arc(tx(dotX), tz(dotZ), 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,110,110,${alpha.toFixed(2)})`; ctx.fill();
    }

    // flow direction arrow at midpoint
    const arrowAngle = Math.atan2(ndx, ndz);   // canvas: right=+x, down=+z
    ctx.save();
    ctx.translate(tx(this.vStartX), tz(this.vStartZ));
    ctx.rotate(arrowAngle);
    ctx.fillStyle = 'rgba(255,70,70,.95)';
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 4); ctx.lineTo(-7, 4); ctx.closePath(); ctx.fill();
    ctx.restore();

    // label
    ctx.fillStyle = 'rgba(255,130,130,.85)'; ctx.font = '9px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(
      `r = ${this.vRadius} mm   v = ${this.vVel} mm/s`,
      tx(this.vStartX) + 10,
      tz(this.vStartZ) - this.vRadius * sc - 6,
    );

    // titles
    ctx.fillStyle = 'rgba(255,90,90,.7)'; ctx.font = 'bold 10px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText('VESSEL PHANTOM', 10, 16);
    ctx.fillStyle = 'rgba(120,140,170,.35)'; ctx.font = '8px IBM Plex Mono,monospace';
    ctx.fillText('Independent Doppler session — separate from Shepp-Logan', 10, 27);
  }

  // ════════════════════════════════════════════════════════════
  //  DRAWING: A-Mode
  // ════════════════════════════════════════════════════════════
  drawAMode() {
    const cv = this.amodeRef?.nativeElement; if (!cv || !this.amodeData) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width = cv.offsetWidth || 500, H = cv.height = cv.offsetHeight || 280;
    ctx.fillStyle = '#0a0e16'; ctx.fillRect(0, 0, W, H);

    const d = this.amodeData; if (!d.depths_mm.length) return;
    const mL = 52, mR = 16, mT = 30, mB = 35;
    const pW = W - mL - mR, pH = H - mT - mB;
    const maxD = Math.max(...d.depths_mm), maxA = Math.max(...d.amplitudes, 1e-3);

    ctx.strokeStyle = 'rgba(80,100,140,.15)'; ctx.lineWidth = .5;
    for (let i = 0; i <= 5; i++) { const y = mT + pH*i/5; ctx.beginPath(); ctx.moveTo(mL,y); ctx.lineTo(W-mR,y); ctx.stroke(); }
    for (let i = 0; i <= 8; i++) { const x = mL + pW*i/8; ctx.beginPath(); ctx.moveTo(x,mT); ctx.lineTo(x,H-mB); ctx.stroke(); }

    ctx.beginPath(); ctx.strokeStyle = '#4aff8a'; ctx.lineWidth = 1.5; ctx.shadowColor = '#4aff8a'; ctx.shadowBlur = 4;
    d.depths_mm.forEach((dep, i) => {
      const x = mL + (dep/maxD)*pW, y = mT + pH - (d.amplitudes[i]/maxA)*pH;
      i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.lineTo(mL+pW, mT+pH); ctx.lineTo(mL, mT+pH); ctx.closePath();
    ctx.fillStyle = 'rgba(74,255,138,.06)'; ctx.fill();

    ctx.fillStyle = 'rgba(160,180,210,.7)'; ctx.font = '10px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText('Depth (mm)', W/2, H-4);
    ctx.save(); ctx.translate(12, H/2); ctx.rotate(-Math.PI/2); ctx.fillText('Amplitude', 0, 0); ctx.restore();
    ctx.fillStyle = 'rgba(140,160,190,.5)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    for (let i = 0; i <= 8; i++) ctx.fillText((maxD*i/8).toFixed(0), mL+pW*i/8, H-mB+12);
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) ctx.fillText((maxA*i/5).toFixed(2), mL-6, mT+pH-pH*i/5+3);

    ctx.fillStyle = 'rgba(74,255,138,.8)'; ctx.font = 'bold 11px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(`A-MODE  ∠${d.angle_deg.toFixed(1)}°  (probe ${this.probeAngle.toFixed(1)}°  steer ${this.beamSteer.toFixed(1)}°)`, mL, mT-10);
  }

  // ════════════════════════════════════════════════════════════
  //  DRAWING: B-Mode
  // ════════════════════════════════════════════════════════════
  drawBMode() {
    const cv = this.bmodeRef?.nativeElement; if (!cv || !this.bmodeData) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width = cv.offsetWidth || 500, H = cv.height = cv.offsetHeight || 400;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

    const d = this.bmodeData;
    if (!d.image_grid.length || !d.image_grid[0].length) return;
    const nL = d.image_grid.length, nD = d.image_grid[0].length;
    const angles = d.sector_angles_deg, depths = d.axial_depths_mm;
    const maxDep = depths[depths.length - 1] || 80;
    const ox = W/2, oy = 25, maxR = H - 45, sc = maxR / maxDep;

    for (let li = 0; li < nL - 1; li++) {
      const a1 = angles[li]*Math.PI/180, a2 = angles[li+1]*Math.PI/180;
      for (let di = 0; di < nD - 1; di++) {
        const r1 = depths[di]*sc, r2 = depths[di+1]*sc;
        const v = (d.image_grid[li][di] + d.image_grid[li][di+1] +
          (li+1<nL ? d.image_grid[li+1][di]   : d.image_grid[li][di]) +
          (li+1<nL ? d.image_grid[li+1][di+1] : d.image_grid[li][di+1])) / 4;
        const b = Math.min(255, Math.max(0, Math.round(v*255)));
        if (b < 2) continue;
        ctx.fillStyle = `rgb(${b},${b},${b})`;
        ctx.beginPath();
        ctx.moveTo(ox+r1*Math.sin(a1), oy+r1*Math.cos(a1));
        ctx.lineTo(ox+r2*Math.sin(a1), oy+r2*Math.cos(a1));
        ctx.lineTo(ox+r2*Math.sin(a2), oy+r2*Math.cos(a2));
        ctx.lineTo(ox+r1*Math.sin(a2), oy+r1*Math.cos(a2));
        ctx.closePath(); ctx.fill();
      }
    }

    ctx.strokeStyle = 'rgba(100,140,200,.2)'; ctx.lineWidth = .5; ctx.setLineDash([2,4]);
    const aMin = angles[0]*Math.PI/180, aMax = angles[nL-1]*Math.PI/180;
    for (let dd = 10; dd <= maxDep; dd += 10) {
      const r = dd*sc;
      ctx.beginPath();
      for (let a = aMin; a <= aMax; a += .02) { const px = ox+r*Math.sin(a), py = oy+r*Math.cos(a); a===aMin?ctx.moveTo(px,py):ctx.lineTo(px,py); }
      ctx.stroke();
      ctx.fillStyle = 'rgba(100,140,200,.4)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${dd}`, ox+r*Math.sin(aMax)+4, oy+r*Math.cos(aMax));
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(100,180,255,.7)'; ctx.font = 'bold 11px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText('B-MODE', 8, 16);
  }

  // ════════════════════════════════════════════════════════════
  //  DRAWING: Doppler result
  // ════════════════════════════════════════════════════════════
  drawDoppler() {
    const cv = this.dopplerRef?.nativeElement; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width = cv.offsetWidth || 500, H = cv.height = cv.offsetHeight || 300;
    ctx.fillStyle = '#0a0e16'; ctx.fillRect(0, 0, W, H);
    if (this.dopplerMode === 'line'  && this.dLineData)   this.drawDopplerLine(ctx, W, H, this.dLineData);
    if (this.dopplerMode === 'color' && this.cDopplerData) this.drawColorDoppler(ctx, W, H, this.cDopplerData);
  }

  private drawDopplerLine(ctx: CanvasRenderingContext2D, W: number, H: number, d: DopplerLineRes) {
    if (!d.depths_mm.length) return;
    const mL = 52, mR = 16, mT = 30, mB = 35;
    const pW = W-mL-mR, pH = H-mT-mB;
    const maxD = Math.max(...d.depths_mm), maxV = Math.max(...d.velocities_ms.map(Math.abs), 1e-3);

    ctx.strokeStyle = 'rgba(80,100,140,.15)'; ctx.lineWidth = .5;
    for (let i = 0; i <= 6; i++) { const y = mT+pH*i/6; ctx.beginPath(); ctx.moveTo(mL,y); ctx.lineTo(W-mR,y); ctx.stroke(); }
    for (let i = 0; i <= 8; i++) { const x = mL+pW*i/8; ctx.beginPath(); ctx.moveTo(x,mT); ctx.lineTo(x,H-mB); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(200,200,200,.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT+pH/2); ctx.lineTo(W-mR, mT+pH/2); ctx.stroke();

    ctx.lineWidth = 1.5;
    d.depths_mm.forEach((dep, i) => {
      const x = mL+(dep/maxD)*pW, y = mT+pH/2-(d.velocities_ms[i]/maxV)*(pH/2);
      if (i===0) { ctx.beginPath(); ctx.moveTo(x,y); return; }
      ctx.strokeStyle = d.velocities_ms[i] > 0 ? '#ff4444' : '#4444ff';
      ctx.lineTo(x,y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x,y);
    });

    const maxP = Math.max(...d.power, 1e-6);
    ctx.globalAlpha = .3;
    d.depths_mm.forEach((dep, i) => {
      const x = mL+(dep/maxD)*pW, h = (d.power[i]/maxP)*20;
      ctx.fillStyle = d.velocities_ms[i]>0 ? '#ff6644':'#4466ff';
      ctx.fillRect(x-1, H-mB-h, 2, h);
    });
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(160,180,210,.7)'; ctx.font = '10px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText('Depth (mm)', W/2, H-4);
    ctx.save(); ctx.translate(12, H/2); ctx.rotate(-Math.PI/2); ctx.fillText('Velocity (m/s)', 0, 0); ctx.restore();
    ctx.fillStyle = 'rgba(140,160,190,.5)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    for (let i = 0; i <= 8; i++) ctx.fillText((maxD*i/8).toFixed(0), mL+pW*i/8, H-mB+12);
    ctx.textAlign = 'right';
    for (let i = -3; i <= 3; i++) ctx.fillText((maxV*i/3).toFixed(2), mL-4, mT+pH/2-(pH/2)*i/3+3);

    ctx.fillStyle = 'rgba(255,100,100,.8)'; ctx.font = 'bold 11px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(`DOPPLER LINE  ∠${d.angle_deg.toFixed(1)}°`, mL, mT-10);
  }

  private drawColorDoppler(ctx: CanvasRenderingContext2D, W: number, H: number, d: ColorDopplerRes) {
    if (!d.velocity_grid.length || !d.velocity_grid[0].length) return;
    const nL = d.velocity_grid.length, nD = d.velocity_grid[0].length;
    const angles = d.sector_angles_deg, depths = d.axial_depths_mm;
    const maxDep = depths[depths.length-1] || 70;
    const ox = W/2, oy = 25, maxR = H-45, sc = maxR/maxDep;

    let maxV = 0;
    d.velocity_grid.forEach(row => row.forEach(v => { if (Math.abs(v) > maxV) maxV = Math.abs(v); }));
    if (maxV < 1e-6) maxV = 1;

    for (let li = 0; li < nL-1; li++) {
      const a1 = angles[li]*Math.PI/180, a2 = angles[li+1]*Math.PI/180;
      for (let di = 0; di < nD-1; di++) {
        const r1 = depths[di]*sc, r2 = depths[di+1]*sc;
        const vel = d.velocity_grid[li][di], pow = d.power_grid[li][di];
        if (pow < .05) continue;
        const norm = Math.min(1, Math.abs(vel)/maxV), alpha = Math.min(1, pow*1.5);
        const r = vel>0?Math.round(255*norm):0, g = 0, b = vel>0?0:Math.round(255*norm);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(ox+r1*Math.sin(a1), oy+r1*Math.cos(a1));
        ctx.lineTo(ox+r2*Math.sin(a1), oy+r2*Math.cos(a1));
        ctx.lineTo(ox+r2*Math.sin(a2), oy+r2*Math.cos(a2));
        ctx.lineTo(ox+r1*Math.sin(a2), oy+r1*Math.cos(a2));
        ctx.closePath(); ctx.fill();
      }
    }

    const barX = W-30, barY = 30, barH = H-80;
    for (let i = 0; i < barH; i++) {
      const v = (1-i/barH-.5)*2;
      ctx.fillStyle = v>0 ? `rgb(${Math.round(255*v)},0,0)` : `rgb(0,0,${Math.round(-255*v)})`;
      ctx.fillRect(barX, barY+i, 14, 1);
    }
    ctx.fillStyle = 'rgba(200,210,220,.6)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(`+${maxV.toFixed(2)}`, barX-2, barY-4);
    ctx.fillText(`-${maxV.toFixed(2)}`, barX-2, barY+barH+10);
    ctx.fillText('0', barX+2, barY+barH/2+3);

    ctx.fillStyle = 'rgba(255,100,100,.8)'; ctx.font = 'bold 11px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText('COLOR DOPPLER', 8, 16);
  }
}