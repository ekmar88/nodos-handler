/**
 * Nodos Node Models
 * Defines the structure and validation for each node type
 */

/**
 * Location Node — represents a 3D vector (vec3)
 * Pins: x, y, z (double values)
 */
class LocationNode {
  constructor(nodeId, pinId) {
    this.nodeId = nodeId;
    this.pinId = pinId;
    this.type = 'vec3';
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }

  /**
   * Set all three components at once
   */
  setValues(x, y, z) {
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.z = Number(z) || 0;
    return this;
  }

  /**
   * Get the value as a vec3 object
   */
  getValue() {
    return { x: this.x, y: this.y, z: this.z };
  }

  /**
   * Validate the values
   */
  validate() {
    const errors = [];
    if (typeof this.x !== 'number') errors.push('x must be a number');
    if (typeof this.y !== 'number') errors.push('y must be a number');
    if (typeof this.z !== 'number') errors.push('z must be a number');
    return errors;
  }
}

/**
 * Double Node — represents a double precision float
 * Pin: value (double)
 */
class DoubleNode {
  constructor(nodeId, pinId) {
    this.nodeId = nodeId;
    this.pinId = pinId;
    this.type = 'double';
    this.value = 0;
  }

  /**
   * Set the double value
   */
  setValue(value) {
    this.value = Number(value) || 0;
    return this;
  }

  /**
   * Get the current value
   */
  getValue() {
    return this.value;
  }

  /**
   * Validate the value
   */
  validate() {
    if (typeof this.value !== 'number') {
      return ['value must be a number'];
    }
    return [];
  }
}

/**
 * String Node — represents a string value
 * Pin: value (string)
 */
class StringNode {
  constructor(nodeId, pinId) {
    this.nodeId = nodeId;
    this.pinId = pinId;
    this.type = 'string';
    this.value = '';
  }

  /**
   * Set the string value
   */
  setValue(value) {
    this.value = String(value) || '';
    return this;
  }

  /**
   * Get the current value
   */
  getValue() {
    return this.value;
  }

  /**
   * Validate the value
   */
  validate() {
    if (typeof this.value !== 'string') {
      return ['value must be a string'];
    }
    return [];
  }
}

/**
 * Bool Node — represents a boolean value
 * Pin: value (bool)
 */
class BoolNode {
  constructor(nodeId, pinId) {
    this.nodeId = nodeId;
    this.pinId = pinId;
    this.type = 'bool';
    this.value = false;
  }

  /**
   * Set the boolean value
   */
  setValue(value) {
    this.value = Boolean(value);
    return this;
  }

  /**
   * Get the current value
   */
  getValue() {
    return this.value;
  }

  /**
   * Validate the value
   */
  validate() {
    // Boolean accepts anything — it will be coerced
    return [];
  }
}

/**
 * Node type registry
 */
const NODE_TYPES = {
  location: LocationNode,
  double: DoubleNode,
  string: StringNode,
  bool: BoolNode,
};

/**
 * Create a node instance by type name
 */
function createNode(type, nodeId, pinId) {
  const NodeClass = NODE_TYPES[type.toLowerCase()];
  if (!NodeClass) {
    throw new Error(`Unknown node type: ${type}. Available: ${Object.keys(NODE_TYPES).join(', ')}`);
  }
  return new NodeClass(nodeId, pinId);
}

export {
  LocationNode,
  DoubleNode,
  StringNode,
  BoolNode,
  NODE_TYPES,
  createNode,
};
