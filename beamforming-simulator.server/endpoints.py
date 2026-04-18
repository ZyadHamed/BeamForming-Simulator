import os
import base64
import numpy as np
from pydantic import BaseModel
from typing import List, Optional, Literal
from PIL import Image
import io
import json

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from Objects.Scenarios.Telecom5GScenario import Telecom5GScenario, UserEquipment, Tower5G 
from Objects.ArrayConfig import ArrayConfig, ProbeElement

from Objects.Scenarios.RadarScenario import RadarScenario, RadarScanResult
from Objects.Physics.RadarEnviroment import RadarEnvironment, RadarTarget as RadarTargetObj

#py -m uvicorn endpoints:app --reload

app = FastAPI()
origins = ["*"]
app.add_middleware(GZipMiddleware, minimum_size=1000)

from fastapi import FastAPI
from pydantic import BaseModel
from typing import List

# Assuming Tower5G, UserEquipment, and Telecom5GScenario are imported from your simulation file

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
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
    beam_pattern: List[float]   # ← add
    angles_deg: List[float]     # ← add

# --- Pydantic Request Models ---
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

class Telecom5GRequest(BaseModel):
    towers: List[TowerRequest]
    users: List[UserRequest]

class TowerSetupRequest(BaseModel):
    towers: List[TowerRequest]

class UserUpdateRequest(BaseModel):
    users: List[UserRequest]

active_scenario: Optional['Telecom5GScenario'] = None

# --- 5G Endpoint ---
@app.post("5g-scenario/towers")
def set_towers(req: TowerSetupRequest):
    """
    Instantiates or updates the towers. Call this only when the map loads 
    or when tower parameters actually change.
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
        # First time setup: create scenario with towers and no users
        active_scenario = Telecom5GScenario(towers=sim_towers, users=[])
    else:
        # Swap out the towers, but keep the existing users in memory
        active_scenario.towers = sim_towers

    return {"message": f"Successfully initialized {len(sim_towers)} towers."}


@app.post("5g-scenario/update-users")
def update_users_and_evaluate(req: UserUpdateRequest):
    """
    Lightweight endpoint for the frontend loop. Updates user coordinates 
    in place and immediately returns the new beam link calculations.
    """
    global active_scenario
    
    if active_scenario is None:
        raise HTTPException(status_code=400, detail="Towers not initialized. Call /towers first.")

    # 1. Map existing users to avoid creating new objects if they already exist
    existing_users = {u.user_id: u for u in active_scenario.users}
    updated_user_list = []

    # 2. Update coordinates in place or create new users if they just spawned
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

    # 3. Save the new user state and run the math
    active_scenario.users = updated_user_list
    result = active_scenario.evaluate_network_links()
    
    return result

# --- Radar State ---
active_radar: Optional[RadarScenario] = None

# --- Radar DTOs ---
class RadarSetupRequest(BaseModel):
    num_elements     : int
    element_spacing  : float
    frequency_mhz   : float
    geometry         : Literal['linear', 'curved', 'phased'] = 'curved'
    curvature_radius : float = 60.0
    snr              : float = 60.0
    apodization      : Literal['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey'] = 'none'
    noise_floor_dbm  : float = -90.0

class RadarTargetDTO(BaseModel):
    target_id  : str
    x_m        : float
    y_m        : float
    velocity_m_s: float = 0.0
    rcs_sqm    : float

class RadarScanRequest(BaseModel):
    start_angle  : float
    end_angle    : float
    num_lines    : int   = 32
    max_range_m  : float = 100.0
    targets      : List[RadarTargetDTO]

# --- Radar Endpoint ---

@app.post("/radar/setup")
def radar_setup(req: RadarSetupRequest):
    """
    Call once when radar mode loads or when array config changes.
    Instantiates the RadarScenario with an empty environment.
    """
    global active_radar

    elements = [
        ProbeElement(
            element_id=f"el_{i}", label=f"E{i}", color="#ea4335",
            frequency=req.frequency_mhz, phase_shift=0.0,
            time_delay=0.0, intensity=100.0, enabled=True
        ) for i in range(req.num_elements)
    ]
    config = ArrayConfig(
        elements=elements,
        steering_angle=0.0,
        focus_depth=0.0,
        element_spacing=req.element_spacing,
        geometry=req.geometry,
        curvature_radius=req.curvature_radius,
        num_elements=req.num_elements,
        snr=req.snr,
        apodization_window=req.apodization,
        wave_speed=300000.0
    )
    config.apply_apodization()

    environment = RadarEnvironment(
        targets=[],
        noise_floor_dbm=req.noise_floor_dbm
    )
    active_radar = RadarScenario(config=config, environment=environment)
    return {"message": f"Radar initialized with {req.num_elements} elements."}

@app.post("/radar/scan")
def radar_scan(req: RadarScanRequest):
    global active_radar

    if active_radar is None:
        raise HTTPException(
            status_code=400,
            detail="Radar not initialized. Call /radar/setup first."
        )

    active_radar.environment.targets = [
        RadarTargetObj(
            target_id    = t.target_id,
            x_m          = t.x_m,
            y_m          = t.y_m,
            velocity_m_s = t.velocity_m_s,
            rcs_sqm      = t.rcs_sqm,
        ) for t in req.targets
    ]

    result = active_radar.generate_ppi_scan(
        start_angle = req.start_angle,
        end_angle   = req.end_angle,
        num_lines   = req.num_lines,
        max_range_m = req.max_range_m,
    )

    return {
        "sweep_data" : result.sweep_data,
        "detections" : [d.__dict__ for d in result.detections],
    }

# --- Pydantic Schemas for API I/O ---



# --- Helper Function ---

def run_simulation(config: ArrayConfig):
    """Executes the beamforming and field computation."""
    # 1. Calculate Results
    bf_result = config.compute_beamforming()
    field_result = config.compute_interference_field(
        width_mm=40.0, 
        depth_mm=60.0, 
        resolution_mm=0.2
    )
    
    # 2. Map to Response
    return {
        "elements": [ElementInput(**el.__dict__) for el in config.elements],
        "beam_pattern": bf_result.beam_pattern_db,
        "angles_deg": bf_result.angles_deg,
        "beam_angle": bf_result.beam_angle,
        "side_lobe_level": bf_result.side_lobe_level,
        "main_lobe_width": bf_result.main_lobe_width,
        "interference_map": field_result.image_base64
    }

# --- Endpoints ---

@app.post("/simulate/from-beam-specs", response_model=SimulationResponse)
async def calculate_from_specs(specs: BeamSpecs):
    """
    OPTION 1: Define beam characteristics. 
    Calculates the required probe element delays/weights and returns the full profile.
    """
    # Create default elements based on specs
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
    
    # Apply the physics-based calculations
    config.apply_apodization()
    config.calculate_steering_delays()
    config.calculate_focus_delays()
    
    return run_simulation(config)


@app.post("/simulate/from-elements", response_model=SimulationResponse)
async def calculate_from_elements(elements: List[ElementInput], steering_angle: float = 0.0, focus_depth: float = 0.0):
    """
    OPTION 2: Provide specific element parameters.
    Finds the resulting beam profile and interference pattern.
    """
    # Convert Pydantic elements back to Dataclass elements
    probe_elements = [ProbeElement(**el.dict()) for el in elements]
    
    config = ArrayConfig(
        elements=probe_elements,
        steering_angle=steering_angle,
        focus_depth=focus_depth,
        element_spacing=0.5, # Assume default or extract from UI
        geometry='linear',
        curvature_radius=0.0,
        num_elements=len(probe_elements),
        snr=60.0,
        apodization_window='none' # Already manually defined in elements
    )
    
    return run_simulation(config)

