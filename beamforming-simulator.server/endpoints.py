import os
import base64
import numpy as np
from pydantic import BaseModel
from typing import List, Optional, Literal
from PIL import Image
import io
import json
from dataclasses import asdict

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from Objects.Scenarios.Telecom5GScenario import Telecom5GScenario, UserEquipment, Tower5G
from Objects.ArrayConfig import ArrayConfig, ProbeElement

# py -m uvicorn endpoints:app --reload

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