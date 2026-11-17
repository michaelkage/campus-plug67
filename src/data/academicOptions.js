export const DEPARTMENTS = [
  'Engineering',
  'Sciences',
  'Medicine & Health Sciences',
  'Arts & Humanities',
  'Social Sciences',
  'Management Sciences',
  'Education',
  'Environmental Sciences',
  'Agriculture & Food Sciences',
  'Law',
  'Other',
]

export const PROGRAMMES_BY_DEPARTMENT = {
  Engineering: [
    'Agricultural Engineering', 'Chemical Engineering', 'Civil Engineering',
    'Computer Engineering', 'Electrical/Electronics Engineering',
    'Mechanical Engineering', 'Other',
  ],
  Sciences: [
    'Biochemistry', 'Biology', 'Chemistry', 'Computer Science',
    'Industrial Chemistry', 'Mathematics', 'Microbiology', 'Physics',
    'Statistics', 'Other',
  ],
  'Medicine & Health Sciences': [
    'Anatomy', 'Dentistry', 'Human Anatomy', 'Medical Laboratory Science',
    'Medicine and Surgery', 'Nursing Science', 'Pharmacy', 'Physiology',
    'Veterinary Medicine', 'Other',
  ],
  'Arts & Humanities': [
    'English and Literary Studies', 'History', 'Linguistics', 'Philosophy',
    'Theatre Arts', 'Fine Arts', 'Other',
  ],
  'Social Sciences': [
    'Economics', 'Geography', 'Political Science', 'Psychology', 'Sociology',
    'Mass Communication', 'Other',
  ],
  'Management Sciences': [
    'Accounting', 'Banking and Finance', 'Business Administration',
    'Finance', 'Insurance', 'Marketing', 'Public Administration',
    'Industrial Relations', 'Other',
  ],
  Education: [
    'Adult Education', 'Education', 'Guidance and Counselling', 'Other',
  ],
  'Environmental Sciences': [
    'Architecture', 'Building', 'Estate Management', 'Quantity Surveying',
    'Surveying and Geoinformatics', 'Urban and Regional Planning', 'Other',
  ],
  'Agriculture & Food Sciences': [
    'Agricultural Economics', 'Agriculture', 'Fisheries',
    'Food Science and Technology', 'Other',
  ],
  Law: ['Law', 'Other'],
  Other: ['Other'],
}

// Compatibility export for places that only need the complete programme list.
export const PROGRAMMES = [...new Set(Object.values(PROGRAMMES_BY_DEPARTMENT).flat())]
export const getProgrammesForDepartment = department =>
  PROGRAMMES_BY_DEPARTMENT[department] || (department ? ['Other'] : [])
