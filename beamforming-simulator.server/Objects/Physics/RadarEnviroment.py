from dataclasses import dataclass
from typing import List

@dataclass
class RadarTarget:
    """Represents an aircraft, ship, or weather anomaly."""
    target_id: str
    x_m: float
    y_m: float
    velocity_m_s: float   # For Doppler processing (if you add it later)
    rcs_sqm: float        # Radar Cross Section in square meters

@dataclass
class RadarEnvironment:
    targets: List[RadarTarget]
    noise_floor_dbm: float = -100.0