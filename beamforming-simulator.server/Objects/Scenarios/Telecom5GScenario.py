from dataclasses import dataclass
from typing import List
from Objects.ArrayConfig import ArrayConfig, ProbeElement
from Objects.Scenarios.Scenario import Scenario
@dataclass
class UserEquipment:
    user_id: str
    x_m: float  
    y_m: float  
    allocated_frequency_mhz: float 

@dataclass
class LinkQuality:
    user_id: str
    tower_id: str
    sector_name: str           # New: Alpha, Beta, or Gamma
    global_angle_deg: float    # The user's bearing on the map   
    local_beam_angle_deg: float # The steering angle relative to the panel face
    snr_db: float              
    data_rate_mbps: float      

@dataclass
class NetworkStateResult:
    timestamp: float
    active_connections: List[LinkQuality]
    dropped_users: List[str]   


@dataclass(eq=False)
class TowerSector:
    """Represents one of the 3 phased-array panels on the tower."""
    name: str
    boresight_angle_deg: float  # The global direction the panel faces
    array_config: 'ArrayConfig'


class Tower5G:
    """Represents a base station containing 3 sector panels for 360-degree coverage."""
    def __init__(self, tower_id: str, x_m: float, y_m: float, 
                 num_elements: int, element_spacing_mm: float, max_coverage_radius_m: float):
        
        self.tower_id = tower_id
        self.x_m = x_m
        self.y_m = y_m
        self.max_coverage_radius_m = max_coverage_radius_m
        
        # Build 3 separate arrays, perfectly mimicking a real triangular cell tower
        # Alpha faces North (0°), Beta faces South-East (120°), Gamma faces South-West (-120°)
        self.sectors = [
            TowerSector("Alpha", 0.0, self._build_array(num_elements, element_spacing_mm)),
            TowerSector("Beta", 120.0, self._build_array(num_elements, element_spacing_mm)),
            TowerSector("Gamma", -120.0, self._build_array(num_elements, element_spacing_mm))
        ]

    def _build_array(self, num_elements: int, element_spacing_mm: float) -> 'ArrayConfig':
        elements = []
        for i in range(num_elements):
            elements.append(ProbeElement(
                element_id=f"tx_{i}", label=f"Antenna-{i}", color="#00FF00",
                frequency=3500.0, phase_shift=0.0, time_delay=0.0, intensity=100.0, 
                enabled=True, apodization_weight=1.0
            ))
            
        return ArrayConfig(
            elements=elements, steering_angle=0.0, focus_depth=0.0,
            element_spacing=element_spacing_mm, geometry='linear', curvature_radius=0.0,
            num_elements=num_elements, snr=100.0, apodization_window='hamming',
            wave_speed=300000.0  # Speed of light
        )
    
from dataclasses import dataclass
from typing import List, Dict, Tuple
import math
import time
import numpy as np
class Telecom5GScenario:
    def __init__(self, towers: List[Tower5G], users: List[UserEquipment]):
        self.towers = towers
        self.users = users
        self.noise_floor_dbm = -95.0
        self.tx_power_dbm = 43.0            
        self.channel_bandwidth_mhz = 100.0  

    def assign_users_to_sectors(self):
        """Assigns users to the closest tower, and then to the correct array panel."""
        # Structure: assignments[Tower][Sector] = [(User, Distance, Global_Angle, Local_Angle)]
        assignments = {t: {s: [] for s in t.sectors} for t in self.towers}
        dropped_users = []

        for user in self.users:
            # 1. Find Closest Tower
            closest_tower = None
            min_dist = float('inf')
            for tower in self.towers:
                dist = math.sqrt((user.x_m - tower.x_m)**2 + (user.y_m - tower.y_m)**2)
                if dist < min_dist and dist <= tower.max_coverage_radius_m:
                    min_dist = dist
                    closest_tower = tower
            
            if not closest_tower:
                dropped_users.append(user.user_id)
                continue
                
            # 2. Find Correct Sector (Alpha, Beta, or Gamma)
            dx = user.x_m - closest_tower.x_m
            dy = user.y_m - closest_tower.y_m
            global_angle = math.degrees(math.atan2(dx, dy))
            
            best_sector = None
            min_angle_diff = float('inf')
            local_angle = 0.0
            
            for sector in closest_tower.sectors:
                # Wrap the angular difference to be between -180 and +180
                diff = (global_angle - sector.boresight_angle_deg + 180) % 360 - 180
                if abs(diff) < min_angle_diff:
                    min_angle_diff = abs(diff)
                    best_sector = sector
                    local_angle = diff
                    
            assignments[closest_tower][best_sector].append((user, min_dist, global_angle, local_angle))

        return assignments, dropped_users

    def compute_superimposed_beam_pattern(self, sector: TowerSector, local_angles_deg: List[float]):
        """Calculates MU-MIMO wave interference for a SINGLE sector panel."""
        if not local_angles_deg:
            return np.linspace(-90, 90, 181), np.full(181, -100.0)

        c, f = 300000.0, 3500.0
        k = 2 * np.pi / (c / f)
        
        num_elements = sector.array_config.num_elements
        pitch = sector.array_config.element_spacing
        x_positions = (np.arange(num_elements) - (num_elements - 1) / 2.0) * pitch
        
        complex_weights = np.zeros(num_elements, dtype=complex)
        for angle in local_angles_deg:
            theta_rad = np.radians(angle)
            complex_weights += np.exp(1j * k * x_positions * np.sin(theta_rad))
            
        complex_weights /= len(local_angles_deg)
            
        scan_angles = np.linspace(-90, 90, 181)
        scan_rads = np.radians(scan_angles)
        steering_matrix = np.exp(-1j * k * np.outer(x_positions, np.sin(scan_rads)))
        
        amplitudes = np.abs(complex_weights @ steering_matrix)
        amplitudes = np.maximum(amplitudes, 1e-10)
        beam_pattern_db = 20 * np.log10(amplitudes)
        
        return scan_angles, beam_pattern_db

    def evaluate_network_links(self) -> NetworkStateResult:
        active_connections = []
        assignments, dropped_users = self.assign_users_to_sectors()

        for tower, sectors in assignments.items():
            for sector, users_data in sectors.items():
                if not users_data:
                    continue

                # Extract local angles for the sector's baseband processor
                local_angles = [data[3] for data in users_data]
                scan_angles, beam_pattern_db = self.compute_superimposed_beam_pattern(sector, local_angles)

                # Link Budget Calculations
                for user, distance_m, global_angle, local_angle in users_data:
                    idx = (np.abs(scan_angles - local_angle)).argmin()
                    antenna_gain_db = beam_pattern_db[idx]

                    # Free Space Path Loss (FSPL)
                    freq_hz = user.allocated_frequency_mhz * 1e6
                    fspl_db = 20.0 * math.log10(distance_m) + 20.0 * math.log10(freq_hz) - 147.55

                    rx_power_dbm = self.tx_power_dbm + antenna_gain_db - fspl_db
                    snr_db = rx_power_dbm - self.noise_floor_dbm

                    snr_linear = 10.0 ** (snr_db / 10.0)
                    data_rate_mbps = self.channel_bandwidth_mhz * math.log2(1.0 + snr_linear) if snr_linear > 0 else 0.0
                    data_rate_mbps = min(data_rate_mbps, 2000.0) 

                    active_connections.append(LinkQuality(
                        user_id=user.user_id, tower_id=tower.tower_id, sector_name=sector.name,
                        global_angle_deg=round(global_angle, 2), local_beam_angle_deg=round(local_angle, 2),
                        snr_db=round(snr_db, 2), data_rate_mbps=round(data_rate_mbps, 2)
                    ))

        return NetworkStateResult(time.time(), active_connections, dropped_users)