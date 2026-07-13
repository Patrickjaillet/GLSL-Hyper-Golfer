// comments and preprocessor lines must survive tokenizing intact
#version 300 es
precision highp float;

float f(float x, float y) {
    float a = 0.5;
    float b = 2.0;
    float c = 3.100;
    float d = 0.0;
    float e = 1.0e-5;
    /* block comment */
    float g = x - -y;   // must never become x--y
    float h = x - - -y;
    float i = x++ + y;
    return a + b + c + d + e + g + h + i;
}
