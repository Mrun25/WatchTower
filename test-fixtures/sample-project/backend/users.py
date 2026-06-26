# backend/users.py
# Flask routes handling user profile reads and updates.

from flask import Flask, request, jsonify

app = Flask(__name__)


@app.route('/api/users/<int:user_id>', methods=['GET'])
def get_user(user_id):
    user = find_user(user_id)
    return jsonify(user)


@app.route('/api/users/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    name = request.json.get('name')
    email = request.json.get('email')
    user = save_user(user_id, name, email)
    return jsonify(user)


def find_user(user_id):
    return {'id': user_id, 'name': 'placeholder', 'email': 'placeholder@example.com'}


def save_user(user_id, name, email):
    return {'id': user_id, 'name': name, 'email': email}
