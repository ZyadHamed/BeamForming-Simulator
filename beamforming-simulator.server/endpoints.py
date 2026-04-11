import os
import base64
import numpy as np
from pydantic import BaseModel
from typing import List, Optional
from PIL import Image
import io
import json

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware



#py -m uvicorn endpoints:app --reload

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

