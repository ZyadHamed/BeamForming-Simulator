import os
import base64
import random
import numpy as np
from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Literal
from PIL import Image
import io
import json
from dataclasses import asdict

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from Objects.Physics.DynamicEnviroment import DynamicEnvironment
from Objects.Physics.Phantom import Phantom, TissueRegion
from Objects.Physics.PulseEchoEngine import PulseEchoEngine
from Objects.Physics.TargetEnviroment import Scatterer, TargetEnvironment
from Objects.Scenarios.Telecom5GScenario import Telecom5GScenario, UserEquipment, Tower5G
from Objects.ArrayConfig import ArrayConfig, ProbeElement

from Objects.Scenarios.RadarScenario import (
    RadarScenario, RadarScanResult, RadarWaveform, RadarDetectionConfig,
)
from Objects.Physics.RadarEnviroment import RadarEnvironment, RadarTarget
from Objects.Scenarios.Ultrasound_Scenario import UltrasoundScenario

# ── Single FastAPI instance ────────────────────────────────────────
app = FastAPI()
origins = ["*"]

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#py -m uvicorn endpoints:app --reload
# ── Pydantic Models ────────────────────────────────────────────────

class ElementInput(BaseModel):
    element_id: str
    label: str
    color: str
    frequency: float
    phase_shift: float
    time_delay: float
    intensity: float
    enabled: bool


class ProbeSpec(BaseModel):
    num_elements:         int   = Field(16,      ge=4,   le=256)
    pitch_mm:             float = Field(0.5,     gt=0)
    frequency_mhz:        float = Field(5.0,     gt=0)
    focus_depth_mm:       float = Field(40.0,    gt=0)
    speed_of_sound_mm_us: float = Field(1.54,    gt=0)
    snr_db:               float = Field(50.0)
    apodization_window:   str   = Field("hamming")
    geometry:             str   = Field("linear")



class BeamSpecs(BaseModel):
    num_elements: int
    element_spacing: float
    steering_angle: float
    focus_depth: float
    frequency_mhz: float
    curvature_radius: float
    snr: float
    geometry: Literal['linear', 'curved', 'phased'] = 'linear'
    apodization: Literal['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey'] = 'hanning'
    wave_speed: float = 1.54

class SimulationResponse(BaseModel):
    elements: List[ElementInput]
    beam_angle: float
    side_lobe_level: Optional[float]
    main_lobe_width: float
    interference_map: str
    beam_pattern: List[float]
    angles_deg: List[float]

class UserRequest(BaseModel):
    user_id: str
    x_m: float
    y_m: float
    allocated_frequency_mhz: float

class TowerRequest(BaseModel):
    tower_id: str
    x_m: float
    y_m: float
    num_elements: int
    element_spacing_mm: float
    max_coverage_radius_m: float

class TowerSetupRequest(BaseModel):
    towers: List[TowerRequest]

class UserUpdateRequest(BaseModel):
    users: List[UserRequest]


class TowerConfigUpdate(BaseModel):
    tower_id: str
    apodization: Literal['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey']
    snr: float
    kaiser_beta: float = 8.6
    num_elements: Optional[int] = None
    element_spacing_mm: Optional[float] = None



# ── Ultrasound Endpoints ───────────────────────────────────────────────────


# Simple in-process store: session_id (str) → UltrasoundScenario
_sessions: Dict[str, UltrasoundScenario] = {}


# ============================================================
# SECTION 6 – Pydantic request / response models
# ============================================================
class TissueRegionSpec(BaseModel):
    name:                     str
    center_x:                 float = Field(..., description="Lateral centre (mm)")
    center_z:                 float = Field(..., description="Axial depth centre (mm)")
    semi_axis_x:              float = Field(..., gt=0, description="Half-width (mm)")
    semi_axis_z:              float = Field(..., gt=0, description="Half-height (mm)")
    rotation_deg:             float = Field(0.0,  description="Ellipse tilt (degrees)")
    speed_of_sound:           float = Field(..., gt=0, description="m/s  e.g. 1540")
    attenuation_db_per_cm_mhz: float = Field(..., gt=0, description="dB/cm/MHz  e.g. 0.5")
    density_kg_m3:            float = Field(..., gt=0, description="kg/m³  e.g. 1060")
    is_fluid:                 bool  = Field(False, description="True = anechoic cyst")


class PhantomSpec(BaseModel):
    regions: List[TissueRegionSpec] = Field(...)
    n_boundary:      int   = Field(50,  ge=8,   le=200)
    grid_spacing_mm: float = Field(2.0, gt=0)
    noise_density:   float = Field(0.05, gt=0, le=1.0)
    seed:            int   = Field(42)
    z_offset_mm:     float = Field(30.0, description="Shift phantom down from probe face")
    max_scatterers:  int   = Field(5000, ge=100, le=20000)

class VesselSpec(BaseModel):
    start_x_mm:             float = Field(..., description="Vessel start position X (mm)")
    start_z_mm:             float = Field(..., description="Vessel start position Z (mm)")
    direction_x:            float = Field(..., description="Direction vector X component")
    direction_z:            float = Field(..., description="Direction vector Z component")
    radius_mm:              float = Field(..., gt=0, description="Vessel radius (mm)")
    velocity_magnitude_mms: float = Field(..., description="Peak flow velocity (mm/s)")
    num_blood_cells:        int   = Field(200, ge=10, le=4000)
    background_noise:       float = Field(0.01, gt=0, le=1.0)


class CreateVesselScenarioRequest(BaseModel):
    session_id:  str        = Field(..., description="Arbitrary client-chosen key")
    probe:       ProbeSpec
    vessel_spec: VesselSpec


class CreateVesselScenarioResponse(BaseModel):
    session_id:     str
    num_scatterers: int
    message:        str


class DopplerLineRequest(BaseModel):
    session_id:  str
    angle_deg:   float = Field(0.0,    ge=-45.0, le=45.0)
    max_depth_mm: float = Field(70.0,  gt=0)
    prf_hz:      float = Field(4000.0, gt=0, description="Pulse repetition frequency (Hz)")
    packet_size: int   = Field(8,      ge=2, le=32,  description="Slow-time ensemble size")


class DopplerLineResponse(BaseModel):
    angle_deg:      float
    depths_mm:      List[float]
    velocities_ms:  List[float]
    power:          List[float]


class ColorDopplerRequest(BaseModel):
    session_id:   str
    start_angle:  float = Field(-35.0, ge=-45.0, le=0.0)
    end_angle:    float = Field( 35.0, ge=0.0,   le=45.0)
    num_lines:    int   = Field(32,    ge=4,      le=128)
    max_depth_mm: float = Field(70.0,  gt=0)
    prf_hz:       float = Field(4000.0, gt=0)
    packet_size:  int   = Field(8,      ge=2, le=32)


class ColorDopplerResponse(BaseModel):
    sector_angles_deg: List[float]
    axial_depths_mm:   List[float]
    velocity_grid:     List[List[float]]
    power_grid:        List[List[float]]

class CreateScenarioRequest(BaseModel):
    session_id:          str
    probe:               ProbeSpec
    use_shepp_logan:     bool = True
    shepp_logan_scale_mm: float = Field(60.0, gt=0, description="Physical size of the Shepp-Logan phantom")
    phantom_spec:        Optional[PhantomSpec] = None


class CreateScenarioResponse(BaseModel):
    session_id: str
    num_scatterers: int
    message: str


class AModeRequest(BaseModel):
    session_id: str
    angle_deg:   float = Field(..., ge=-90, le=90)
    max_depth_mm: float = Field(80.0, gt=0)


class AModeResponse(BaseModel):
    angle_deg:   float
    depths_mm:   List[float]
    amplitudes:  List[float]


class BModeRequest(BaseModel):
    session_id:   str
    start_angle:  float = Field(-30.0, ge=-90)
    end_angle:    float = Field( 30.0, le= 90)
    num_lines:    int   = Field(35,    ge=1, le=256)
    max_depth_mm: float = Field(80.0,  gt=0)


class BModeResponse(BaseModel):
    sector_angles_deg: List[float]
    axial_depths_mm:   List[float]
    image_grid:        List[List[float]]   # shape: [num_lines][num_depth_samples]


class DefaultBModeRequest(BaseModel):
    session_id:   str
    max_depth_mm: float = Field(80.0, gt=0)






# ============================================================
# SECTION 4 – Shepp-Logan Phantom builder
# ============================================================

SHEPP_LOGAN_REGIONS: List[TissueRegion] = [
    TissueRegion("Body",            0.0,  40.0, 38.0, 35.0,  0.0, 1540.0, 0.5,  1060.0, False),
    TissueRegion("Outer skull",     0.0,  40.0, 34.0, 32.0,  0.0, 3500.0, 10.0, 1900.0, False),
    TissueRegion("Brain",           0.0,  40.0, 29.0, 28.0,  0.0, 1560.0, 0.6,  1040.0, False),
    TissueRegion("Left ventricle", -8.0,  32.0,  9.0, 11.5, 18.0, 1480.0, 0.002,1000.0, True),
    TissueRegion("Right ventricle", 9.0,  32.0,  6.5,  9.0,-18.0, 1480.0, 0.002,1000.0, True),
    TissueRegion("Lesion A",       -3.0,  55.0,  4.6,  4.6,  0.0, 1560.0, 0.8,  1080.0, False),
    TissueRegion("Lesion B",        4.0,  58.0,  2.3,  2.3,  0.0, 1560.0, 0.8,  1080.0, False),
    TissueRegion("Cyst",           -5.0,  65.0,  3.5,  4.5,  0.0, 1480.0, 0.002,1000.0, True),
    TissueRegion("Calcification",   3.0,  68.0,  1.5,  1.0,  0.0, 3500.0, 12.0, 2000.0, False),
    TissueRegion("Background",      0.0,  40.0, 40.0, 40.0,  0.0, 1540.0, 0.5,  1060.0, False),
]

def build_phantom_env(regions: List[TissueRegion],
                      n_boundary: int = 40,
                      grid_spacing_mm: float = 3.0,
                      noise_density: float = 0.1,
                      seed: int = 42,
                      z_offset: float = 0.0,           # NEW
                      max_scatterers: int = 5000) -> TargetEnvironment:  # NEW
    rng = np.random.default_rng(seed)
    scatterers: List[Scatterer] = []
    half = 40.0
    Z_ambient = 1000 * 1500

    for idx, region in enumerate(regions):
        thetas = np.linspace(0, 2 * np.pi, n_boundary, endpoint=False)
        for theta in thetas:
            bx = region.semi_axis_x * np.cos(theta)
            bz = region.semi_axis_z * np.sin(theta)
            cos_r = np.cos(np.deg2rad(region.rotation_deg))
            sin_r = np.sin(np.deg2rad(region.rotation_deg))
            rx = bx * cos_r - bz * sin_r + region.center_x
            rz = bx * sin_r + bz * cos_r + region.center_z
            if abs(rx) < half:
                Z_out = Z_ambient
                for i in range(idx - 1, -1, -1):
                    if regions[i].contains_point(rx, rz):
                        Z_out = regions[i].acoustic_impedance
                        break
                R = abs((region.acoustic_impedance - Z_out) /
                        (region.acoustic_impedance + Z_out))
                refl = R * 5.0 * (0.9 + 0.1 * rng.random())
                scatterers.append(Scatterer(rx, rz + z_offset,
                                            float(np.clip(refl, 0, 1))))

    xs = np.arange(-half, half, grid_spacing_mm)
    zs = np.arange(0, half * 2, grid_spacing_mm)
    for x in xs:
        for z in zs:
            if rng.random() > noise_density:
                continue
            for region in reversed(regions):
                if region.contains_point(x, z):
                    refl = (rng.random() * 0.001 if region.is_fluid
                            else max(0.0, rng.normal(0.02 * region.density_kg_m3 / 1000,
                                                     0.006)))
                    scatterers.append(Scatterer(x, z + z_offset,
                                                float(np.clip(refl, 0, 1))))
                    break

    # Much more generous cap
    if len(scatterers) > max_scatterers:
        rnd = random.Random(seed)
        scatterers = rnd.sample(scatterers, max_scatterers)

    return TargetEnvironment(scatterers=scatterers, background_noise_level=0.005)

def build_shepp_logan_phantom(scale_mm: float = 80.0) -> List[TissueRegion]:
    s = scale_mm / 2.0
    return [
        TissueRegion("Body Wall", 0.0, s * 0.0, s * 0.92, s * 0.69, 0.0, 1540, 0.5, 1060, False),
        TissueRegion("Liver Parenchyma", 0.0, s * -0.0184, s * 0.874, s * 0.6624, 0.0, 1570, 0.5, 1060, False),
        TissueRegion("Hyperechoic Lesion (Right)", s * -0.31, s * -0.22, s * 0.31, s * 0.11, -18.0, 1560, 0.6, 1040, False),
        TissueRegion("Hyperechoic Lesion (Left)", s * 0.31, s * -0.22, s * 0.31, s * 0.11, 18.0, 1560, 0.6, 1040, False),
        TissueRegion("Gallbladder (Cyst)", s * 0.0, s * -0.35, s * 0.25, s * 0.21, 0.0, 1480, 0.002, 1000, True),
        TissueRegion("Nodule A", s * -0.22, s * 0.0, s * 0.046, s * 0.046, 0.0, 1550, 0.7, 1050, False),
        TissueRegion("Nodule B", s * 0.22, s * 0.0, s * 0.046, s * 0.046, 0.0, 1550, 0.7, 1050, False),
        TissueRegion("Fat Layer", s * 0.0, s * -0.605, s * 0.046, s * 0.023, 0.0, 1450, 0.5, 950, False),
        TissueRegion("Vessel Wall", s * 0.0, s * -0.605, s * 0.023, s * 0.023, -90.0, 1580, 1.0, 1070, False),
        TissueRegion("Dense Structure (Bone-like)", s * 0.0, s * 0.605, s * 0.046, s * 0.023, 0.0, 3500, 10.0, 1900, False),
    ]



def build_array_config(spec: "ProbeSpec") -> ArrayConfig:
    elements = [
        ProbeElement(element_id=f"el_{i}", label=f"E{i}", color="#00FF00",
                     frequency=spec.frequency_mhz, phase_shift=0.0,
                     time_delay=0.0, intensity=100.0,
                     enabled=True, apodization_weight=1.0)
        for i in range(spec.num_elements)
    ]
    cfg = ArrayConfig(
        elements=elements,
        steering_angle=0.0,
        focus_depth=spec.focus_depth_mm,
        element_spacing=spec.pitch_mm,
        geometry=spec.geometry,
        curvature_radius=0.0,
        num_elements=spec.num_elements,
        snr=spec.snr_db,
        apodization_window=spec.apodization_window,
        wave_speed=spec.speed_of_sound_mm_us,
    )
    cfg.apply_apodization()
    return cfg

# ============================================================
# SECTION 7 – Endpoints
# ============================================================

# ── Endpoint 3 ──────────────────────────────────────────────
@app.post("/scenario/create", response_model=CreateScenarioResponse,
          summary="Instantiate an UltrasoundScenario (Endpoint 3)")
def create_scenario(req: CreateScenarioRequest):
    """
    Builds a probe ArrayConfig and a TargetEnvironment, then stores an
    UltrasoundScenario under `session_id`.

    **Phantom options**
    - `use_shepp_logan: true`  → the built-in 10-region Shepp-Logan head phantom is used;
                                  `phantom_spec` is ignored.
    - `use_shepp_logan: false` → `phantom_spec` is required. The user supplies every
                                  TissueRegion with its geometry and acoustic properties.
    """
    # ── 1. Build probe ───────────────────────────────────────
    cfg = build_array_config(req.probe)

    # ── 2. Build environment ─────────────────────────────────
    if req.use_shepp_logan:
        scale = req.shepp_logan_scale_mm          # or hardcode 60.0 if not adding the field yet
        regions = build_shepp_logan_phantom(scale_mm=scale)
        phantom = Phantom(regions=regions, scale_mm=scale)
        env = phantom.get_scatterer_environment(
            grid_spacing_mm=2.0,
            noise_density=0.05,
            n_boundary=50,
        )
        for s in env.scatterers:
            s.z += scale / 2.0

    else:
        if req.phantom_spec is None:
            raise HTTPException(
                status_code=422,
                detail="phantom_spec is required when use_shepp_logan=false. "
                       "Supply at least one TissueRegion with its acoustic properties."
            )

        # Convert each Pydantic TissueRegionSpec → internal TissueRegion dataclass
        regions: List[TissueRegion] = [
            TissueRegion(
                name                     = r.name,
                center_x                 = r.center_x,
                center_z                 = r.center_z,
                semi_axis_x              = r.semi_axis_x,
                semi_axis_z              = r.semi_axis_z,
                rotation_deg             = r.rotation_deg,
                speed_of_sound           = r.speed_of_sound,
                attenuation_db_per_cm_mhz= r.attenuation_db_per_cm_mhz,
                density_kg_m3            = r.density_kg_m3,
                is_fluid                 = r.is_fluid,
            )
            for r in req.phantom_spec.regions
        ]

        env = build_phantom_env(
            regions         = regions,
            n_boundary      = req.phantom_spec.n_boundary,
            grid_spacing_mm = req.phantom_spec.grid_spacing_mm,
            noise_density   = req.phantom_spec.noise_density,
            seed            = req.phantom_spec.seed,
            z_offset        = req.phantom_spec.z_offset_mm,
            max_scatterers  = req.phantom_spec.max_scatterers,
        )

    # ── 3. Instantiate and store scenario ────────────────────
    engine   = PulseEchoEngine(array=cfg, environment=env)
    scenario = UltrasoundScenario(config=cfg, environment=env, engine=engine)
    _sessions[req.session_id] = scenario

    return CreateScenarioResponse(
        session_id     = req.session_id,
        num_scatterers = len(env.scatterers),
        message        = f"Scenario '{req.session_id}' ready with "
                         f"{len(env.scatterers)} scatterers.")

# ── Endpoint 2 ──────────────────────────────────────────────
# POST /scan/amode
# Takes angle_deg + max_depth → returns depths[] and amplitudes[]
@app.post("/scan/amode", response_model=AModeResponse,
          summary="Run a single A-mode line (Endpoint 2)")
def scan_amode(req: AModeRequest):
    """
    Fires a single steered A-mode pulse along `angle_deg` and returns
    the depth axis and the envelope amplitude array.
    """
    scenario = _sessions.get(req.session_id)
    if scenario is None:
        raise HTTPException(404, f"Session '{req.session_id}' not found. "
                                  "Call /scenario/create first.")
    result = scenario.generate_a_mode(req.angle_deg, req.max_depth_mm)
    return AModeResponse(angle_deg=result.angle_deg,
                         depths_mm=result.depths_mm,
                         amplitudes=result.amplitudes)


# ── Endpoint 1 ──────────────────────────────────────────────
# POST /scan/bmode
# Takes start_angle, end_angle, num_lines, max_depth → returns full image
@app.post("/scan/bmode", response_model=BModeResponse,
          summary="Run a full B-mode sector sweep (Endpoint 1)")
def scan_bmode(req: BModeRequest):
    """
    Sweeps `num_lines` A-mode lines from `start_angle` to `end_angle`,
    applies global dB normalisation (50 dB dynamic range) and returns
    the pixel intensity grid ready for plotting.
    """
    scenario = _sessions.get(req.session_id)
    if scenario is None:
        raise HTTPException(404, f"Session '{req.session_id}' not found. "
                                  "Call /scenario/create first.")
    result = scenario.generate_b_mode(req.start_angle, req.end_angle,
                                      req.num_lines, req.max_depth_mm)
    return BModeResponse(sector_angles_deg=result.sector_angles_deg,
                         axial_depths_mm=result.axial_depths_mm,
                         image_grid=result.image_grid)


# ── Endpoint 4 ──────────────────────────────────────────────
# POST /scenario/default_bmode
# Returns the default B-mode for a pre-existing session
@app.post("/scenario/default_bmode", response_model=BModeResponse,
          summary="Default B-mode on an existing scenario (Endpoint 4)")
def default_bmode(req: DefaultBModeRequest):
    """
    Calls `perform_default_scan()` on the stored UltrasoundScenario,
    which sweeps ±45° with 64 lines.  The session must already exist.
    """
    scenario = _sessions.get(req.session_id)
    if scenario is None:
        raise HTTPException(404, f"Session '{req.session_id}' not found. "
                                  "Call /scenario/create first.")
    result = scenario.perform_default_scan(max_depth_mm=req.max_depth_mm)
    return BModeResponse(sector_angles_deg=result.sector_angles_deg,
                         axial_depths_mm=result.axial_depths_mm,
                         image_grid=result.image_grid)


@app.post("/scenario/create_vessel", response_model=CreateVesselScenarioResponse,
          summary="Create a dynamic vessel scenario (Endpoint 5)")
def create_vessel_scenario(req: CreateVesselScenarioRequest):
    """
    Builds a DynamicEnvironment containing a blood vessel with parabolic
    (Poiseuille) flow, then stores an UltrasoundScenario under `session_id`.
    """
    cfg = build_array_config(req.probe)

    v = req.vessel_spec
    env: DynamicEnvironment = DynamicEnvironment.create_vessel(
        start_pos               = (v.start_x_mm, v.start_z_mm),
        direction_vector        = (v.direction_x, v.direction_z),
        radius_mm               = v.radius_mm,
        velocity_magnitude_mms  = v.velocity_magnitude_mms,
        num_blood_cells         = v.num_blood_cells,
        background_noise        = v.background_noise,
    )

    engine   = PulseEchoEngine(array=cfg, environment=env)
    scenario = UltrasoundScenario(config=cfg, environment=env, engine=engine)
    _sessions[req.session_id] = scenario

    return CreateVesselScenarioResponse(
        session_id     = req.session_id,
        num_scatterers = len(env.scatterers),
        message        = f"Vessel scenario '{req.session_id}' ready with "
                         f"{len(env.scatterers)} blood cell scatterers.",
    )


# ── Endpoint 6 ──────────────────────────────────────────────
@app.post("/scan/doppler_line", response_model=DopplerLineResponse,
          summary="Run a single Doppler line (Endpoint 6)")
def scan_doppler_line(req: DopplerLineRequest):
    """
    Fires a slow-time ensemble of pulses along `angle_deg`, applies the
    Kasai autocorrelation estimator, and returns depth, velocity, and
    power arrays.  The session must already exist (call /scenario/create
    or /scenario/create_vessel first).
    """
    scenario = _sessions.get(req.session_id)
    if scenario is None:
        raise HTTPException(404, f"Session '{req.session_id}' not found. "
                                  "Call /scenario/create or /scenario/create_vessel first.")

    result = scenario.generate_doppler_line(
        angle_deg    = req.angle_deg,
        max_depth_mm = req.max_depth_mm,
        prf_hz       = req.prf_hz,
        packet_size  = req.packet_size,
    )

    return DopplerLineResponse(
        angle_deg     = result.angle_deg,
        depths_mm     = result.depths_mm,
        velocities_ms = result.velocities_ms,
        power         = result.power,
    )


# ── Endpoint 7 ──────────────────────────────────────────────
@app.post("/scan/color_doppler", response_model=ColorDopplerResponse,
          summary="Run a full Color Doppler sector sweep (Endpoint 7)")
def scan_color_doppler(req: ColorDopplerRequest):
    """
    Sweeps `num_lines` Doppler packets from `start_angle` to `end_angle`,
    returns a 2D velocity grid (m/s) and a normalised power grid (dB)
    for client-side colour thresholding.  The session must already exist.
    """
    scenario = _sessions.get(req.session_id)
    if scenario is None:
        raise HTTPException(404, f"Session '{req.session_id}' not found. "
                                  "Call /scenario/create or /scenario/create_vessel first.")

    result = scenario.generate_color_doppler(
        start_angle  = req.start_angle,
        end_angle    = req.end_angle,
        num_lines    = req.num_lines,
        max_depth_mm = req.max_depth_mm,
        prf_hz       = req.prf_hz,
        packet_size  = req.packet_size,
    )

    return ColorDopplerResponse(
        sector_angles_deg = result.sector_angles_deg,
        axial_depths_mm   = result.axial_depths_mm,
        velocity_grid     = result.velocity_grid,
        power_grid        = result.power_grid,
    )


# ── State ──────────────────────────────────────────────────────────

active_scenario: Optional[Telecom5GScenario] = None

# ── 5G Endpoints ───────────────────────────────────────────────────

@app.post("/5g-scenario/towers")
def set_towers(req: TowerSetupRequest):
    global active_scenario
    sim_towers = [
        Tower5G(
            tower_id=t.tower_id, x_m=t.x_m, y_m=t.y_m,
            num_elements=t.num_elements, element_spacing_mm=t.element_spacing_mm,
            max_coverage_radius_m=t.max_coverage_radius_m
        ) for t in req.towers
    ]
    if active_scenario is None:
        active_scenario = Telecom5GScenario(towers=sim_towers, users=[])
    else:
        active_scenario.towers = sim_towers
    return {"message": f"Successfully initialized {len(sim_towers)} towers."}


@app.post("/5g-scenario/update-users")
def update_users_and_evaluate(req: UserUpdateRequest):
    global active_scenario
    if active_scenario is None:
        raise HTTPException(status_code=400, detail="Towers not initialized. Call /5g-scenario/towers first.")

    existing_users = {u.user_id: u for u in active_scenario.users}
    updated_user_list = []
    for u_data in req.users:
        if u_data.user_id in existing_users:
            user = existing_users[u_data.user_id]
            user.x_m = u_data.x_m
            user.y_m = u_data.y_m
            user.allocated_frequency_mhz = u_data.allocated_frequency_mhz
            updated_user_list.append(user)
        else:
            updated_user_list.append(UserEquipment(
                user_id=u_data.user_id, x_m=u_data.x_m,
                y_m=u_data.y_m, allocated_frequency_mhz=u_data.allocated_frequency_mhz
            ))

    active_scenario.users = updated_user_list
    result = active_scenario.evaluate_network_links()
    return {
        "timestamp": result.timestamp,
        "active_connections": [asdict(link) for link in result.active_connections],
        "dropped_users": result.dropped_users,
    }


@app.post("/5g-scenario/update-tower-config")
def update_tower_config(req: TowerConfigUpdate):
    """
    Update apodization window and SNR for a specific tower's sectors.
    Optionally update num_elements and element_spacing_mm too.
    Returns the new beam patterns for all 3 sectors immediately.
    """
    global active_scenario
    if active_scenario is None:
        raise HTTPException(status_code=400, detail="Towers not initialized.")

    tower = next((t for t in active_scenario.towers if t.tower_id == req.tower_id), None)
    if not tower:
        raise HTTPException(status_code=404, detail=f"Tower '{req.tower_id}' not found.")

    # Apply config changes to all 3 sector arrays
    for sector in tower.sectors:
        cfg = sector.array_config
        cfg.apodization_window = req.apodization
        cfg.snr = req.snr

        # Optionally rebuild array if element count or spacing changed
        if req.num_elements and req.num_elements != cfg.num_elements:
            cfg.num_elements = req.num_elements
            cfg.elements = [
                ProbeElement(
                    element_id=f"tx_{i}", label=f"Antenna-{i}", color="#00FF00",
                    frequency=3500.0, phase_shift=0.0, time_delay=0.0,
                    intensity=100.0, enabled=True, apodization_weight=1.0
                ) for i in range(req.num_elements)
            ]
        if req.element_spacing_mm:
            cfg.element_spacing = req.element_spacing_mm

        # Re-apply apodization weights with new window
        cfg.apply_apodization()

    # Return fresh beam patterns for all sectors (no users needed)
    return _build_tower_beams_response(tower, active_connections=[])


@app.get("/5g-scenario/tower-beams/{tower_id}")
def get_tower_beams(tower_id: str):
    """
    Returns the polar beam pattern data for all 3 sector arrays of a tower.
    Uses the current steering angles derived from connected users.
    """
    global active_scenario
    if active_scenario is None:
        raise HTTPException(status_code=400, detail="Towers not initialized.")

    tower = next((t for t in active_scenario.towers if t.tower_id == tower_id), None)
    if not tower:
        raise HTTPException(status_code=404, detail=f"Tower '{tower_id}' not found.")

    # Get current active connections for this tower to compute steering angles
    active_connections = []
    if active_scenario.users:
        result = active_scenario.evaluate_network_links()
        active_connections = [c for c in result.active_connections if c.tower_id == tower_id]

    return _build_tower_beams_response(tower, active_connections)


def _build_tower_beams_response(tower: Tower5G, active_connections: list) -> dict:
    """
    Shared helper: computes beam patterns for all 3 sectors and
    returns a structured response the frontend can render directly.
    """
    # Map sector_name → list of local angles from connected users
    sector_user_angles: Dict[str, List[float]] = {"Alpha": [], "Beta": [], "Gamma": []}
    for conn in active_connections:
        if conn.sector_name in sector_user_angles:
            sector_user_angles[conn.sector_name].append(conn.local_beam_angle_deg)

    sectors_response = []
    for sector in tower.sectors:
        local_angles = sector_user_angles.get(sector.name, [])

        # Use the scenario's own MU-MIMO beam computation
        scan_angles_arr, beam_pattern_db_arr = _compute_sector_pattern(sector, local_angles)

        # Steering angle = average of connected users' local angles (0 if none)
        steering_angle = (sum(local_angles) / len(local_angles)) if local_angles else 0.0

        cfg = sector.array_config
        sectors_response.append({
            "name"            : sector.name,
            "boresight_deg"   : sector.boresight_angle_deg,
            "steering_angle_deg": round(steering_angle, 2),
            "global_pointing_deg": round(sector.boresight_angle_deg + steering_angle, 2),
            "scan_angles_deg" : scan_angles_arr.tolist(),
            "beam_pattern_db" : beam_pattern_db_arr.tolist(),
            # Array config snapshot so the frontend can display params
            "array_config": {
                "num_elements"      : cfg.num_elements,
                "element_spacing_mm": cfg.element_spacing,
                "frequency_mhz"     : cfg.elements[0].frequency if cfg.elements else 3500.0,
                "apodization"       : cfg.apodization_window,
                "snr_db"            : cfg.snr,
            }
        })

    return {
        "tower_id": tower.tower_id,
        "sectors" : sectors_response,
    }


def _compute_sector_pattern(sector, local_angles_deg: list):
    """
    Thin wrapper around Telecom5GScenario.compute_superimposed_beam_pattern
    so we can call it without instantiating a full scenario object.
    """
    dummy_scenario = Telecom5GScenario(towers=[], users=[])
    return dummy_scenario.compute_superimposed_beam_pattern(sector, local_angles_deg)



# --- Radar State ---
active_radar: Optional[RadarScenario] = None

# --- Radar DTOs ---
class RadarSetupRequest(BaseModel):
    # ── Array geometry ─────────────────────────────────────────────────────
    num_elements     : int
    element_spacing  : float                                          # mm
    frequency_mhz    : float                                          # MHz
    geometry         : Literal['linear', 'curved', 'phased'] = 'linear'
    curvature_radius : float  = 60.0
    steering_angle   : float  = 0.0
    focus_depth      : float  = 0.0
    snr              : float  = 60.0                                  # dB, 0–1000
    apodization      : Literal['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey'] = 'none'
    elements         : List[ElementInput] = []

    # ── Waveform (maps to RadarWaveform value object) ──────────────────────
    pt_dbm           : float  = 70.0
    prf_hz           : float  = 1000.0
    pulse_width_us   : float  = 1.0

    # ── Environment (maps to RadarEnvironment) ─────────────────────────────
    noise_floor_dbm  : float  = -100.0
    clutter_floor_dbm: float  = -200.0
    clutter_range_exp: float  = -20.0

    # ── Detector (maps to RadarDetectionConfig) ────────────────────────────
    cfar_guard_cells : int    = 2
    cfar_ref_cells   : int    = 8
    cfar_pfa         : float  = 1e-4

class RadarTargetDTO(BaseModel):
    target_id  : str
    x_m        : float
    y_m        : float
    velocity_m_s: float = 0.0
    rcs_sqm    : float

class RadarScanRequest(BaseModel):
    start_angle    : float
    end_angle      : float
    num_lines      : int   = 36
    max_range_m    : float = 150_000.0
    num_range_bins : int   = 128
    targets        : List[RadarTargetDTO]

class RadarInfoResponse(BaseModel):
    """
    Derived radar parameters echoed back after /radar/setup.
    """
    num_elements           : int
    carrier_freq_hz        : float
    wavelength_m           : float
    array_gain_db          : float
    hpbw_deg               : float
    range_resolution_m     : float
    max_unambiguous_range_m: float
    pt_dbm                 : float
    prf_hz                 : float
    pulse_width_us         : float
    noise_floor_dbm        : float
    
    # --- Added for UI Antenna Pattern Plotting ---
    beam_pattern           : List[float]
    angles_deg             : List[float]
    beam_angle             : float
    main_lobe_width        : float
    side_lobe_level        : Optional[float]
    
    interference_image : str
    interference_cols  : int
    interference_rows  : int

# --- Radar Endpoints ---

def _build_array_config(req: RadarSetupRequest) -> ArrayConfig:
    """
    Private factory: translate a RadarSetupRequest into an ArrayConfig.

    Extracted from the endpoint handler to keep the handler thin.
    """
    if req.elements:
        elements = [
            ProbeElement(
                element_id        = el.element_id,
                label             = el.label,
                color             = el.color,
                frequency         = el.frequency,
                phase_shift       = el.phase_shift,
                time_delay        = el.time_delay,
                intensity         = el.intensity,
                enabled           = el.enabled,
                apodization_weight= getattr(el, 'apodization_weight', 1.0),
            ) for el in req.elements
        ]
    else:
        elements = [
            ProbeElement(
                element_id  = f"el_{i}",
                label       = f"E{i}",
                color       = "#ea4335",
                frequency   = req.frequency_mhz,
                phase_shift = 0.0,
                time_delay  = 0.0,
                intensity   = 100.0,
                enabled     = True,
            ) for i in range(req.num_elements)
        ]

    config = ArrayConfig(
        elements           = elements,
        steering_angle     = req.steering_angle,
        focus_depth        = req.focus_depth,
        element_spacing    = req.element_spacing,
        geometry           = req.geometry,
        curvature_radius   = req.curvature_radius,
        num_elements       = req.num_elements,
        snr                = req.snr,
        apodization_window = req.apodization,
        kaiser_beta        = 14.0,
        tukey_alpha        = 0.5,
        wave_speed         = 300_000.0,
    )
    # Apply apodization only when elements weren't supplied with explicit weights
    if not req.elements:
        config.apply_apodization()

    return config

@app.post("/radar/setup", response_model=RadarInfoResponse)
def radar_setup(req: RadarSetupRequest):
    """
    Instantiate (or replace) the active RadarScenario session.

    Called once when the radar page loads and again whenever the array
    configuration, waveform, or detector parameters change.
    """
    global active_radar

    config = _build_array_config(req)

    waveform = RadarWaveform(
        pt_dbm         = req.pt_dbm,
        prf_hz         = req.prf_hz,
        pulse_width_us = req.pulse_width_us,
    )

    environment = RadarEnvironment(
        targets            = [],
        noise_floor_dbm    = req.noise_floor_dbm,
        clutter_floor_dbm  = req.clutter_floor_dbm,
        clutter_range_exp  = req.clutter_range_exp,
    )

    detection_cfg = RadarDetectionConfig(
        guard_cells = req.cfar_guard_cells,
        ref_cells   = req.cfar_ref_cells,
        pfa         = req.cfar_pfa,
    )

    # RadarScenario inherits Scenario (ABC)
    active_radar = RadarScenario(
        config        = config,
        environment   = environment,
        waveform      = waveform,
        detection_cfg = detection_cfg,
    )

    params = active_radar.get_scan_parameters()
    
    # Compute the antenna's beam pattern so the UI can graph the lobes!
    config.calculate_steering_delays()
    bf_result = config.compute_beamforming()
    
    n_el      = len([e for e in active_radar.config.elements if e.enabled])
    aperture  = (n_el - 1) * active_radar.config.element_spacing
    width_mm  = max(aperture * 4, 100.0)
    depth_mm  = width_mm
    res_mm    = width_mm / 250.0   # keep ~250 pixels across

    interference = active_radar.compute_interference_field(
        width_mm      = width_mm,
        depth_mm      = depth_mm,
        resolution_mm = res_mm,
    )
    
    #     width_mm      = 500.0,
    #     depth_mm      = 500.0,
    #     resolution_mm = 2.0,

    return RadarInfoResponse(
        num_elements            = req.num_elements,
        carrier_freq_hz         = params["carrier_freq_hz"],
        wavelength_m            = params["wavelength_m"],
        array_gain_db           = params["array_gain_db"],
        hpbw_deg                = params["hpbw_deg"],
        range_resolution_m      = params["range_resolution_m"],
        max_unambiguous_range_m = params["max_unambiguous_range_m"],
        pt_dbm                  = params["pt_dbm"],
        prf_hz                  = params["prf_hz"],
        pulse_width_us          = params["pulse_width_us"],
        noise_floor_dbm         = params["noise_floor_dbm"],
        
        # --- NEW: Inject beamforming results ---
        beam_pattern            = bf_result.beam_pattern_db,
        angles_deg              = bf_result.angles_deg,
        beam_angle              = bf_result.beam_angle,
        main_lobe_width         = bf_result.main_lobe_width,
        side_lobe_level         = bf_result.side_lobe_level,
        
        interference_image = interference.image_base64,
        interference_cols  = interference.cols,
        interference_rows  = interference.rows,
    )

@app.post("/radar/scan")
def radar_scan(req: RadarScanRequest):
    """
    Execute a PPI sector scan and return sweep data plus CFAR detections.
    """
    global active_radar

    if active_radar is None:
        raise HTTPException(
            status_code = 400,
            detail      = "Radar not initialized. Call POST /radar/setup first.",
        )

    if len(req.targets) > 5:
        raise HTTPException(
            status_code = 422,
            detail      = "Maximum of 5 solid bodies allowed per the simulator spec.",
        )

    # Replace environment targets via the encapsulated method
    # (does not trigger a full re-instantiation of the scenario)
    active_radar.environment.targets = [
        RadarTarget(
            target_id    = t.target_id,
            x_m          = t.x_m,
            y_m          = t.y_m,
            velocity_m_s = t.velocity_m_s,
            rcs_sqm      = t.rcs_sqm,
        ) for t in req.targets
    ]

    result = active_radar.generate_ppi_scan(
        start_angle    = req.start_angle,
        end_angle      = req.end_angle,
        num_lines      = req.num_lines,
        max_range_m    = req.max_range_m,
        num_range_bins = req.num_range_bins,
    )

    return {
            "sweep_data" : result.sweep_data,
            "detections" : [vars(d) for d in result.detections],
        }

# --- Pydantic Schemas for API I/O ---

    # ── Convert dataclass → plain dict for JSON serialization ──────
    return {
        "timestamp": result.timestamp,
        "active_connections": [asdict(link) for link in result.active_connections],
        "dropped_users": result.dropped_users,
    }


# ── Beamforming Endpoints ──────────────────────────────────────────

def run_simulation(config: ArrayConfig):
    """Executes the beamforming and field computation."""
    bf_result = config.compute_beamforming()
    field_result = config.compute_interference_field(
        width_mm=40.0,
        depth_mm=60.0,
        resolution_mm=0.2
    )
    return {
        "elements": [ElementInput(**el.__dict__) for el in config.elements],
        "beam_pattern": bf_result.beam_pattern_db,
        "angles_deg": bf_result.angles_deg,
        "beam_angle": bf_result.beam_angle,
        "side_lobe_level": bf_result.side_lobe_level,
        "main_lobe_width": bf_result.main_lobe_width,
        "interference_map": field_result.image_base64
    }


@app.post("/simulate/from-beam-specs", response_model=SimulationResponse)
async def calculate_from_specs(specs: BeamSpecs):
    """
    OPTION 1: Define beam characteristics.
    Calculates the required probe element delays/weights and returns the full profile.
    """
    elements = [
        ProbeElement(
            element_id=f"el_{i}",
            label=f"Element {i}",
            color="#3498db",
            frequency=specs.frequency_mhz,
            phase_shift=0.0,
            time_delay=0.0,
            intensity=100.0,
            enabled=True
        ) for i in range(specs.num_elements)
    ]

    config = ArrayConfig(
        elements=elements,
        steering_angle=specs.steering_angle,
        focus_depth=specs.focus_depth,
        element_spacing=specs.element_spacing,
        geometry=specs.geometry,
        curvature_radius=specs.curvature_radius,
        num_elements=specs.num_elements,
        snr=specs.snr,
        apodization_window=specs.apodization,
        wave_speed=specs.wave_speed
    )

    config.apply_apodization()
    config.calculate_steering_delays()
    config.calculate_focus_delays()

    return run_simulation(config)


@app.post("/simulate/from-elements", response_model=SimulationResponse)
async def calculate_from_elements(
    elements: List[ElementInput],
    steering_angle: float = 0.0,
    focus_depth: float = 0.0
):
    """
    OPTION 2: Provide specific element parameters.
    Finds the resulting beam profile and interference pattern.
    """
    probe_elements = [ProbeElement(**el.dict()) for el in elements]

    config = ArrayConfig(
        elements=probe_elements,
        steering_angle=steering_angle,
        focus_depth=focus_depth,
        element_spacing=0.5,
        geometry='linear',
        curvature_radius=0.0,
        num_elements=len(probe_elements),
        snr=60.0,
        apodization_window='none'
    )

    return run_simulation(config)