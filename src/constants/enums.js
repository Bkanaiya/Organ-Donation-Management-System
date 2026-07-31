
const ORGAN_TYPES = [
    'Kidney',
    'Liver',
    'Heart',
    'Lungs',
    'Pancreas',
    'Small Intestine',
    'Cornea',
    'Skin',
    'Bone',
    'Bone Marrow',
    'Heart Valve'
];

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const GENDERS = ['male', 'female', 'other'];

const BLOOD_COMPATIBILITY = {
    'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+': ['O+', 'A+', 'B+', 'AB+'],
    'A-': ['A-', 'A+', 'AB-', 'AB+'],
    'A+': ['A+', 'AB+'],
    'B-': ['B-', 'B+', 'AB-', 'AB+'],
    'B+': ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+']
};

module.exports = { ORGAN_TYPES, BLOOD_GROUPS, GENDERS , BLOOD_COMPATIBILITY};