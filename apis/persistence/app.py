from decorators import validate_pad_id, validate_language, require_auth
from flask import Flask, g, jsonify, request
from database import DatabaseManager
import shortuuid

app = Flask(__name__)

@app.before_request
def load_db():
    g.storage = DatabaseManager(app.config['TESTING'])

@app.route('/api/pads/<pad_id>', methods=['GET'])
@validate_pad_id
def get_pad_language(pad_id):
    """Gets pad info, which is just the current language of the pad"""
    language = g.storage.get_pad_language(pad_id)

    # The following shouldn't really happen, but it is there in case
    if not language:
        return jsonify({'error': 'Pad does not have a language'}), 404

    return jsonify({'language': language}), 200

@app.route('/api/pads/<pad_id>', methods=['PATCH'])
@validate_pad_id
def update_pad_language(pad_id):
    """Updates pad language"""
    new_language = request.get_json().get('language')
    if not new_language:
        return jsonify({'error': 'Missing language'}), 400
    g.storage.update_pad_language(pad_id, new_language)
    return '', 204

@app.route('/api/pads', methods=['POST'])
@require_auth
def create_new_pad():
    """Creates a new pad and inserts into the database"""
    while True:
        pad_id = shortuuid.ShortUUID().random(length=8)
        if not g.storage.is_existing_pad(pad_id):
            break
    g.storage.create_pad(pad_id)
    return jsonify({'pad_id': pad_id}), 201

@app.route('/api/pads/<pad_id>/content/<language>', methods=['GET'])
@validate_pad_id
@validate_language
def get_pad_content(pad_id, language):
    content = g.storage.get_pad_content(pad_id, language)
    return jsonify({'content': content}), 200

@app.route('/api/pads/<pad_id>/content/<language>', methods=['PATCH'])
@validate_pad_id
@validate_language
def update_pad_content(pad_id, language):
    content = request.get_json().get('content')
    if content is None:
        return jsonify({'error': 'Missing content'}), 400
    if not g.storage.pad_language_combo_exists(pad_id, language):
        return jsonify({'error': 'Pad language combo does not exist'}), 400
    g.storage.update_pad_content(pad_id, language, content)
    return '', 204

if __name__ == '__main__':
    app.run(debug=True, port=5003)