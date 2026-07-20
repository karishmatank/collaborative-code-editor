from flask import g, jsonify, request
from functools import wraps
import os

VALID_LANGUAGES = ['python', 'ruby', 'javascript', 'typescript', 'sql', 'html']

def validate_pad_id(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        pad_id = kwargs.get('pad_id')
        is_existing_pad = g.storage.is_existing_pad(pad_id)
        if not is_existing_pad:
            return jsonify({'error': 'Pad not found'}), 404
        return func(*args, **kwargs)
    return wrapper

def validate_language(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        language = kwargs.get('language')
        if language not in VALID_LANGUAGES:
            return jsonify({'error': 'Pad language is invalid'}), 404
        return func(*args, **kwargs)
    return wrapper

def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        token = request.headers.get('Authorization')
        if token != f'Bearer {os.getenv('AUTH_TOKEN')}':
            return jsonify({'error': 'Not authorized'}), 401
        return func(*args, **kwargs)
    return wrapper