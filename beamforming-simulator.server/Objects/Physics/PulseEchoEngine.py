import numpy as np

from ArrayConfig import ArrayConfig
from Objects.Physics.TargetEnviroment import TargetEnvironment

class PulseEchoEngine:
    def __init__(self, array: 'ArrayConfig', environment: 'TargetEnvironment'):
        self.array = array
        self.environment = environment

# Ensure you import Tuple if you use strict typing: from typing import Tuple
    def compute_channel_data(self, num_samples: int, sampling_rate_mhz: float):
            """
            Calculates the raw RF time-domain signals received by EVERY element.
            Returns a tuple: (channel_data_matrix, time_vector).
            """
            num_elements = len(self.array.elements)
            channel_data = np.zeros((num_elements, num_samples))
            
            # Construct the time vector (in microseconds)
            t = np.arange(num_samples) / sampling_rate_mhz 
            c = self.array.speed_of_sound
            fc = 5.0  
            pulse_width = 0.2  
            
            x_positions = self.array._element_x_positions()
            
            # Calculate transmit steering delays
            angle_rad = np.deg2rad(self.array.steering_angle)
            tx_delays = (x_positions * np.sin(angle_rad)) / c
            tx_delays -= np.min(tx_delays) 

            # Loop through scatterers, but VECTORIZE the transmitters and receivers
            for scatterer in self.environment.scatterers:
                
                distances = np.sqrt((x_positions - scatterer.x)**2 + scatterer.z**2)
                
                # 1D arrays of size (num_elements,)
                tx_tofs = (distances / c) + tx_delays
                rx_tofs = distances / c
                
                # Create a 2D matrix of shape (num_rx, num_tx) containing all flight times
                # rx_tofs[:, np.newaxis] makes it a column, tx_tofs[np.newaxis, :] makes it a row
                total_tofs = rx_tofs[:, np.newaxis] + tx_tofs[np.newaxis, :]
                
                # Broadcast into 3D: (num_rx, num_tx, num_samples)
                # This generates the time shifts for all Tx/Rx pairs simultaneously
                time_shifts = t[np.newaxis, np.newaxis, :] - total_tofs[:, :, np.newaxis]
                
                # Calculate all pulses at once (heavy math handled in C backend)
                pulses = np.cos(2 * np.pi * fc * time_shifts) * np.exp(-(time_shifts**2) / (pulse_width**2))
                
                # Sum across the Tx elements (axis=1) -> shape becomes (num_rx, num_samples)
                # Scale by reflectivity and add directly to channel buffer
                channel_data += np.sum(pulses, axis=1) * scatterer.reflectivity
                    
            return channel_data, t