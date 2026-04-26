import os
import base64
import numpy as np
from pydantic import BaseModel
from typing import List, Optional, Literal
from PIL import Image
import io
import json
from dataclasses import asdict
import asyncio

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from Objects.Scenarios.Telecom5GScenario import Telecom5GScenario, UserEquipment, Tower5G
from Objects.ArrayConfig import ArrayConfig, ProbeElement

from Objects.Scenarios.RadarScenario import (
    RadarScenario, RadarScanResult, RadarWaveform, RadarDetectionConfig,
)
from Objects.Physics.RadarEnviroment import RadarEnvironment, RadarTarget

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

# ── State ──────────────────────────────────────────────────────────

active_scenario: Optional[Telecom5GScenario] = None

# ── 5G Endpoints ───────────────────────────────────────────────────

@app.post("/5g-scenario/towers")
def set_towers(req: TowerSetupRequest):
    """
    Instantiates or updates the towers.
    Call this only when the map loads or when tower parameters actually change.
    """
    global active_scenario

    sim_towers = [
        Tower5G(
            tower_id=t.tower_id,
            x_m=t.x_m,
            y_m=t.y_m,
            num_elements=t.num_elements,
            element_spacing_mm=t.element_spacing_mm,
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
    """
    Lightweight endpoint for the frontend loop.
    Updates user coordinates and returns new beam link calculations.
    """
    global active_scenario

    if active_scenario is None:
        raise HTTPException(
            status_code=400,
            detail="Towers not initialized. Call /5g-scenario/towers first."
        )

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
                user_id=u_data.user_id,
                x_m=u_data.x_m,
                y_m=u_data.y_m,
                allocated_frequency_mhz=u_data.allocated_frequency_mhz
            ))

    active_scenario.users = updated_user_list
    result = active_scenario.evaluate_network_links()
    
    return result

# --- Radar State ---
active_radar: Optional[RadarScenario] = None
_radar_lock = asyncio.Lock()  

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
    num_range_bins : int   = 128          # ← ADDED
    targets        : List[RadarTargetDTO]
    radar_type     : Literal['phased_array', 'traditional'] = 'phased_array'

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

@app.websocket("/radar/scan")
async def ws_radar_scan(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if active_radar is None:
                await websocket.send_text(json.dumps({"error": "Radar not initialized"}))
                continue

            req = RadarScanRequest(**msg)

            async with _radar_lock:
                active_radar.environment.targets = [
                    RadarTarget(
                        target_id    = t.target_id,
                        x_m          = t.x_m,
                        y_m          = t.y_m,
                        velocity_m_s = t.velocity_m_s,
                        rcs_sqm      = t.rcs_sqm,
                    ) for t in req.targets
                ]
            
            async with _radar_lock:
                if req.radar_type == 'traditional':
                    result = active_radar.generate_traditional_scan(
                        start_angle    = req.start_angle,
                        end_angle      = req.end_angle,
                        num_lines      = req.num_lines,
                        max_range_m    = req.max_range_m,
                        num_range_bins = req.num_range_bins,
                    )
                else:
                    result = active_radar.generate_ppi_scan(
                        start_angle    = req.start_angle,
                        end_angle      = req.end_angle,
                        num_lines      = req.num_lines,
                        max_range_m    = req.max_range_m,
                        num_range_bins = req.num_range_bins,
                    )

            n_el     = len([e for e in active_radar.config.elements if e.enabled])
            aperture = (n_el - 1) * active_radar.config.element_spacing
            width_mm = max(aperture * 4, 100.0)
            depth_mm = width_mm
            res_mm   = width_mm / 250.0

            interference = active_radar.compute_interference_field(
                width_mm      = width_mm,
                depth_mm      = depth_mm,
                resolution_mm = res_mm,
            )

            bf_result = active_radar.config.compute_beamforming()

            await websocket.send_text(json.dumps({
                "sweep_data"        : result.sweep_data,
                "detections"        : [vars(d) for d in result.detections],
                "interference_image": interference.image_base64,
                "interference_cols" : interference.cols,
                "interference_rows" : interference.rows,
                "beam_pattern"      : bf_result.beam_pattern_db,
                "angles_deg"        : bf_result.angles_deg,
                "beam_angle"        : bf_result.beam_angle,
                "main_lobe_width"   : bf_result.main_lobe_width,
                "side_lobe_level"   : bf_result.side_lobe_level,
            }))

    except WebSocketDisconnect:
        pass
# # --- Pydantic Schemas for API I/O ---

#     # ── Convert dataclass → plain dict for JSON serialization ──────
#     return {
#         "timestamp": result.timestamp,
#         "active_connections": [asdict(link) for link in result.active_connections],
#         "dropped_users": result.dropped_users,
#     }


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