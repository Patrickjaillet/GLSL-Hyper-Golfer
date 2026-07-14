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
    float j = 1000000.0;   // shorter as 1e6
    float k = 0.0001;      // shorter as 1e-4
    float l = 123456.0;    // stays decimal (shorter than 1.23456e5)
    int m[1000000];        // must stay a bare int, never 1e6
    return a + b + c + d + e + g + h + i + j + k + l + float(m[0]);
}
