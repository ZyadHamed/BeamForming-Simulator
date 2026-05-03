from dataclasses import dataclass, field
from scipy.signal import windows
from typing import List

@dataclass
class Scatterer:
    """Represents a single point-target in space."""
    x: float            # Lateral position (mm)
    z: float            # Depth position (mm)
    reflectivity: float # 0.0 to 1.0 (How strong the echo is)
    
@dataclass
class TargetEnvironment:
    """The physical space containing all targets."""
    scatterers: List[Scatterer]
    background_noise_level: float = 0.01 # Adds realism to the RF data


